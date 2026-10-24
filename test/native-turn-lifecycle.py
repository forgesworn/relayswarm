#!/usr/bin/env python3
"""Authenticated, finite native TURN lifecycle tests using synthetic UDP only.

E2E_NATIVE_BINDING must name an explicitly prepared raw addon. No live service,
real credentials, media or installed package is touched. Every scenario gets a
dedicated native process; global cleanup is used only at its final exit.
"""
import hashlib, hmac, json, os, selectors, socket, struct, subprocess, time
from pathlib import Path

MAGIC = 0x2112a442
USER, REALM, PASSWORD = b'fixture', b'fixture.invalid', b'fixture-password'
KEY = hashlib.md5(USER + b':' + REALM + b':' + PASSWORD).digest()
OLD, NEW = b'initial-fixture-nonce', b'fresh-fixture-nonce'

def attribute(kind, value):
    return struct.pack('!HH', kind, len(value)) + value + b'\0' * (-len(value) % 4)

def response(kind, tx, payload, key=KEY):
    header = struct.pack('!HHI', kind, len(payload) + (24 if key else 0), MAGIC) + tx
    return header + payload + (attribute(8, hmac.new(key, header + payload, hashlib.sha1).digest()) if key else b'')

def attrs(packet):
    result, offset = {}, 20
    while offset + 4 <= len(packet):
        kind, size = struct.unpack('!HH', packet[offset:offset + 4])
        if offset + 4 + size > len(packet): return {}
        result[kind] = packet[offset + 4:offset + 4 + size]
        offset += 4 + ((size + 3) & ~3)
    return result

def integrity(packet):
    offset = 20
    while offset + 4 <= len(packet):
        kind, size = struct.unpack('!HH', packet[offset:offset + 4])
        if kind == 8 and size == 20 and offset + 24 <= len(packet):
            header = packet[:2] + struct.pack('!H', offset + 4) + packet[4:20]
            return hmac.compare_digest(packet[offset + 4:offset + 24], hmac.new(KEY, header + packet[20:offset], hashlib.sha1).digest())
        offset += 4 + ((size + 3) & ~3)
    return False

def address(ip, port):
    return bytes([0, 1]) + struct.pack('!H', port ^ (MAGIC >> 16)) + struct.pack('!I', struct.unpack('!I', socket.inet_aton(ip))[0] ^ MAGIC)

PROGRAM = r'''
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
const native=createRequire(process.env.E2E_NATIVE_BINDING)(process.env.E2E_NATIVE_BINDING);
native.initLogger('None',()=>{});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
let peers=[],channels=[];
try {
 for(let cycle=0;cycle<Number(process.env.PROBE_CYCLES);cycle++) {
  const candidates=[];
  for(let i=0;i<8;i++) {
   const pc=new native.PeerConnection('synthetic-lifecycle-'+cycle+'-'+i, {iceServers:[{hostname:'127.0.0.1',port:Number(process.env.PROBE_PORT),username:'fixture',password:'fixture-password',relayType:'TurnUdp'}],iceTransportPolicy:'relay'});
   peers.push(pc); pc.onLocalDescription(()=>{});
   candidates.push(new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('relay candidate timeout')),5000);pc.onLocalCandidate(c=>{if(c.includes(' typ relay')){clearTimeout(timer);resolve()}})}));
   channels.push(pc.createDataChannel('synthetic-lifecycle',{unordered:true,maxPacketLifeTime:250}));
  }
  await Promise.all(candidates);console.log(JSON.stringify({ready:cycle}));
  if((await lines.next()).value!=='close')throw Error('fixture control');
  for(const channel of channels)channel.close();channels=[];
  for(const pc of peers)pc.close();peers=[];
  await wait(1100);console.log(JSON.stringify({closed:cycle}));
  if((await lines.next()).value!=='continue')throw Error('fixture allocation retention');
 }
 native.cleanup();console.log(JSON.stringify({cleanupReturned:true}));
 // Late responses may arrive after the bounded release loop. Keep the JS
 // process alive briefly so lifecycle crashes cannot hide behind exit.
 await wait(200);process.stdin.destroy();
}catch(error){console.log(JSON.stringify({failed:true}));for(const pc of peers)pc.close();native.cleanup();process.exitCode=1}
'''

def run_case(mode):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('127.0.0.1', 0)); sock.setblocking(False)
    cycles = 2 if mode in ('normal', 'drop-first-two', 'stale-delayed') else 1
    env = {**os.environ, 'PROBE_PORT': str(sock.getsockname()[1]), 'PROBE_CYCLES': str(cycles)}
    child = subprocess.Popen([os.environ.get('PROBE_NODE_BINARY', 'node'), '--input-type=module', '-e', PROGRAM], env=env,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    sel = selectors.DefaultSelector(); sel.register(sock, selectors.EVENT_READ); sel.register(child.stdout, selectors.EVENT_READ)
    allocations, known, delayed, states, transitions = {}, {}, [], [], []
    allocated = releases = auth_releases = invalid = challenges = 0
    cleanup = False; first_close = None; max_requests = 0; failed = False
    started = time.monotonic(); continuation_deadline = None
    try:
        while child.poll() is None and time.monotonic() - started < 20:
            now = time.monotonic()
            if continuation_deadline is not None and (not allocations or now >= continuation_deadline):
                transitions.append(len(allocations))
                if mode != 'blackhole': failed |= len(allocations) != 0
                child.stdin.write('continue\n'); child.stdin.flush(); continuation_deadline = None
            for due, data, destination in delayed[:]:
                if now >= due:
                    sock.sendto(data, destination); delayed.remove((due, data, destination))
            for event, _ in sel.select(.01):
                if event.fileobj is child.stdout:
                    line = child.stdout.readline()
                    if not line: continue
                    item = json.loads(line)
                    if 'ready' in item:
                        transitions.append(len(allocations)); failed |= len(allocations) != 8
                        if first_close is None: first_close = time.monotonic()
                        if mode == 'stale-delayed':
                            for state in allocations.values(): state['nonce'] = NEW
                        child.stdin.write('close\n'); child.stdin.flush()
                    elif 'closed' in item:
                        # The serial native destroy queue can legitimately use
                        # 8 * 500ms under a partition. Global cleanup below is
                        # the final bounded native join, not this 1.1s sample.
                        continuation_deadline = time.monotonic() + (0 if mode == 'blackhole' else 6)
                    elif item.get('cleanupReturned'): cleanup = True
                    elif item.get('failed'): failed = True
                    continue
                packet, source = sock.recvfrom(65536)
                if len(packet) < 20: continue
                kind, length, cookie = struct.unpack('!HHI', packet[:8])
                if cookie != MAGIC or length + 20 != len(packet): continue
                a, tx = attrs(packet), packet[8:20]
                if kind == 3 and 6 not in a:
                    body = attribute(9, b'\0\0\4\1Unauthorized') + attribute(20, REALM) + attribute(21, OLD)
                    sock.sendto(response(0x0113, tx, body, None), source); continue
                authenticated = integrity(packet) and a.get(6) == USER and a.get(20) == REALM
                if kind == 3:
                    if not authenticated or a.get(21) != OLD: invalid += 1; continue
                    if source not in allocations:
                        if len(allocations) >= 8: failed = True; continue
                        state = {'nonce': OLD, 'requests': 0, 'challenged': False, 'oldtx': None}
                        allocations[source] = state; known[source] = state; states.append(state); allocated += 1
                    body = attribute(22, address('203.0.113.1', 50000)) + attribute(13, struct.pack('!I', 600)) + attribute(32, address(*source))
                    sock.sendto(response(0x0103, tx, body), source)
                elif kind == 4 and a.get(13) == b'\0\0\0\0':
                    releases += 1
                    state = known.get(source)
                    if not authenticated or state is None or a.get(21) not in (OLD, NEW): invalid += 1; continue
                    auth_releases += 1; state['requests'] += 1; max_requests = max(max_requests, state['requests'])
                    if a.get(21) != state['nonce']:
                        if not state['challenged']:
                            state['challenged'] = True; state['oldtx'] = tx; challenges += 1
                            body = attribute(9, b'\0\0\4\x26Stale Nonce') + attribute(20, REALM) + attribute(21, NEW)
                            delayed.append((time.monotonic() + .350, response(0x0114, tx, body), source))
                        continue
                    if mode == 'stale-delayed' and tx == state['oldtx']: failed = True; continue
                    if mode == 'blackhole': continue
                    if mode == 'drop-first-two' and state['requests'] <= 2: continue
                    if mode in ('forged-hmac', 'forged-txid') and state['requests'] <= 2:
                        forged = response(0x0104, bytes([tx[0] ^ 1]) + tx[1:] if mode == 'forged-txid' else tx,
                                          attribute(13, b'\0\0\0\0'), b'wrong-fixture-key' if mode == 'forged-hmac' else KEY)
                        sock.sendto(forged, source); continue
                    allocations.pop(source, None)
                    ack = response(0x0104, tx, attribute(13, b'\0\0\0\0'))
                    if mode == 'late-ack': delayed.append((time.monotonic() + .650, ack, source))
                    elif mode != 'lost-ack': sock.sendto(ack, source)
        if child.poll() is None: child.kill(); failed = True
        stdout, stderr = child.communicate(timeout=2)
        for line in stdout.splitlines():
            item = json.loads(line); cleanup |= item.get('cleanupReturned', False); failed |= item.get('failed', False)
        close_ms = round((time.monotonic() - first_close) * 1000) if first_close else None
        positive = mode != 'blackhole'
        passed = not failed and child.returncode == 0 and cleanup and invalid == 0 and max_requests <= 6 and auth_releases == releases and allocated == 8 * cycles
        passed &= (len(allocations) == (0 if positive else 8)) and (close_ms is not None and close_ms < 9000)
        if mode == 'stale-delayed': passed &= challenges == 8 * cycles
        if mode.startswith('forged-'): passed &= all(state['requests'] >= 3 for state in states)
        return {'scenario': mode, 'passed': bool(passed), 'cycles': cycles, 'allocationTransitions': transitions,
                'authenticatedAllocates': allocated, 'refreshZeroRequests': releases, 'authenticatedSameTupleReleaseRequests': auth_releases,
                'invalidReleaseRequests': invalid, 'maximumRequestsPerAllocation': max_requests, 'staleNonceChallenges': challenges,
                'remainingAllocations': len(allocations), 'cleanupReturned': cleanup, 'closeToProcessExitMs': close_ms,
                'partitionReleaseExpected': False if not positive else None, 'exitCode': child.returncode, 'stderrPresent': bool(stderr)}
    finally:
        if child.poll() is None: child.kill(); child.wait()
        sel.close(); sock.close()

if __name__ == '__main__':
    assert Path(os.environ['E2E_NATIVE_BINDING']).resolve().is_file(), 'Explicit native addon required'
    scenarios = os.environ.get('PROBE_SCENARIOS', 'normal,drop-first-two,stale-delayed,forged-hmac,forged-txid,lost-ack,late-ack,blackhole').split(',')
    assert scenarios and all(mode in ('normal', 'drop-first-two', 'stale-delayed', 'forged-hmac', 'forged-txid', 'lost-ack', 'late-ack', 'blackhole') for mode in scenarios), 'Unknown lifecycle scenario'
    results = [run_case(mode) for mode in scenarios]
    print(json.dumps({'passed': all(case['passed'] for case in results), 'syntheticCredentialsOnly': True, 'liveServiceContacted': False, 'results': results}))
    raise SystemExit(0 if all(case['passed'] for case in results) else 1)
