#!/usr/bin/env python3
"""Finite authenticated TURN-close gate; synthetic loopback only.

Supply E2E_NATIVE_PACKAGE_ROOT for exact stock 0.33.4, or E2E_NATIVE_BINDING
for an explicitly built sidecar. PROBE_MODE=facade exercises the owned facade;
default raw tests the dependency directly. Missing Refresh(0) is a failure,
not a skipped success. No real relay, credential or media is used.
"""
import socket,struct,hashlib,hmac,time,subprocess,json,os,selectors
from pathlib import Path
package_root=Path(os.environ['E2E_NATIVE_PACKAGE_ROOT']).resolve()
metadata=json.loads((package_root/'package.json').read_text())
assert metadata['name']=='node-datachannel' and metadata['version']=='0.33.4'
facade=(Path(__file__).resolve().parent.parent/'src/node/native-realtime.mjs').as_uri()
MAGIC=0x2112a442
USER='fixture';REALM='fixture.invalid';PASSWORD='fixture-password';NONCE='fixture-close-nonce'
KEY=hashlib.md5(f'{USER}:{REALM}:{PASSWORD}'.encode()).digest()
def attribute(kind,value):return struct.pack('!HH',kind,len(value))+value+b'\0'*((-len(value))%4)
def response(kind,tx,payload,key=None):
 header=struct.pack('!HHI',kind,len(payload)+(24 if key else 0),MAGIC)+tx
 if key:payload+=attribute(8,hmac.new(key,header+payload,hashlib.sha1).digest())
 return header+payload
def integrity(packet):
 offset=20
 while offset+4<=len(packet):
  kind,size=struct.unpack('!HH',packet[offset:offset+4])
  if kind==8 and size==20:
   header=packet[:2]+struct.pack('!H',offset+24-20)+packet[4:20]
   return hmac.compare_digest(packet[offset+4:offset+24],hmac.new(KEY,header+packet[20:offset],hashlib.sha1).digest())
  offset+=4+((size+3)&~3)
 return False
def address(ip,port):return bytes([0,1])+struct.pack('!H',port^(MAGIC>>16))+struct.pack('!I',struct.unpack('!I',socket.inet_aton(ip))[0]^MAGIC)
def attrs(packet):
 result={};offset=20
 while offset+4<=len(packet):
  kind,size=struct.unpack('!HH',packet[offset:offset+4]);offset+=4;result[kind]=packet[offset:offset+size];offset+=(size+3)&~3
 return result
sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);sock.bind(('127.0.0.1',0));sock.setblocking(False)
program=r'''
import{createRequire}from'node:module';
const{createNativeRealtimeBackend}=await import(process.env.PROBE_FACADE_URL);
const require=createRequire(process.env.PROBE_PACKAGE_ROOT+'/package.json');
const native=require(process.env.E2E_NATIVE_BINDING||process.env.PROBE_PACKAGE_ROOT);
native.initLogger('None',()=>{});
let pc,backend;const times={};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let candidateResolve,candidateReject;const candidate=new Promise((r,j)=>{candidateResolve=r;candidateReject=j});
 const timer=setTimeout(()=>candidateReject(new Error('No relay candidate')),6000);
 const config={iceServers:[{hostname:'127.0.0.1',port:Number(process.env.PROBE_PORT),username:'fixture',password:'fixture-password',relayType:'TurnUdp'}],iceTransportPolicy:'relay'};
 if(process.env.PROBE_MODE==='facade'){
  backend=await createNativeRealtimeBackend({nodeDataChannel:native,packageVersion:'0.33.4'});
  pc=new backend.RTCPeerConnectionImpl({iceServers:[{urls:'turn:127.0.0.1:'+process.env.PROBE_PORT+'?transport=udp',username:'fixture',credential:'fixture-password'}],iceTransportPolicy:'relay'});
  pc.addEventListener('icecandidate',event=>{if(event.candidate?.candidate.includes(' typ relay'))candidateResolve()});
  pc.createDataChannel('relayswarm-live-v1',{ordered:false,maxPacketLifeTime:250});
 }else{
  pc=new native.PeerConnection('fixture-close',config);pc.onLocalDescription(()=>{});pc.onLocalCandidate(c=>{if(c.includes(' typ relay'))candidateResolve()});
  pc.createDataChannel('fixture-close',{unordered:true,maxPacketLifeTime:250});
 }
 await candidate;clearTimeout(timer);times.relayCandidate=true;times.closedAt=Date.now();pc.close();
 await wait(1000);times.cleanupAt=Date.now();if(backend)backend.disposeForProcessExit();else native.cleanup();
 times.cleanupReturned=true;console.log(JSON.stringify(times));await wait(1500);
}catch(error){console.log(JSON.stringify({failed:true,reason:error.message}));try{pc?.close();native.cleanup()}catch{}process.exitCode=1;}
'''
mode=os.environ.get('PROBE_MODE','raw');env={**os.environ,'PROBE_PORT':str(sock.getsockname()[1]),'PROBE_MODE':mode,'PROBE_PACKAGE_ROOT':str(package_root),'PROBE_FACADE_URL':facade}
child=subprocess.Popen(['node','--input-type=module','-e',program],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
requests=[];started=time.monotonic();authenticated=0;observations=None;socketReleased=None;lastClient=None
try:
 while child.poll() is None and time.monotonic()-started<15:
  ready=selectors.DefaultSelector();ready.register(sock,selectors.EVENT_READ);ready.register(child.stdout,selectors.EVENT_READ);events=ready.select(.1);ready.close()
  if not events:continue
  if any(key.fileobj is child.stdout for key,mask in events):
   line=child.stdout.readline()
   if line:
    observations=json.loads(line)
    if observations.get('cleanupReturned') and lastClient:
     probe=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
     try:probe.bind(lastClient);socketReleased=child.poll() is None
     except OSError:socketReleased=False
     finally:probe.close()
  if not any(key.fileobj is sock for key,mask in events):continue
  packet,source=sock.recvfrom(65536)
  if len(packet)<20:continue
  kind,length,cookie=struct.unpack('!HHI',packet[:8]);a=attrs(packet);tx=packet[8:20]
  lifetime=struct.unpack('!I',a[13])[0] if 13 in a and len(a[13])==4 else None
  requests.append({'method':kind,'lifetime':lifetime,'at':round(time.time()*1000)})
  if kind==3 and 6 not in a:
   body=attribute(9,bytes([0,0,4,1])+b'Unauthorized')+attribute(20,REALM.encode())+attribute(21,NONCE.encode())
   sock.sendto(response(0x0113,tx,body),source)
  elif kind==3:
   if not integrity(packet):continue
   if a.get(6)!=USER.encode() or a.get(20)!=REALM.encode() or a.get(21)!=NONCE.encode():continue
   authenticated+=1;lastClient=source
   body=attribute(22,address('203.0.113.1',50000))+attribute(13,struct.pack('!I',600))+attribute(32,address(*source))
   sock.sendto(response(0x0103,tx,body,KEY),source)
  elif kind==4:
   sock.sendto(response(0x0104,tx,attribute(13,struct.pack('!I',lifetime or 0)),KEY),source)
 if child.poll() is None:child.kill()
 stdout,stderr=child.communicate(timeout=2)
 observations=observations or (json.loads(stdout.strip()) if stdout.strip() else {'emptyResult':True})
 result={'mode':mode,'exitCode':child.returncode,'authenticatedAllocates':authenticated,'turnRequests':[{k:v for k,v in r.items() if k!='at'} for r in requests],'refreshZeroRequests':sum(r['method']==4 and r['lifetime']==0 for r in requests),'clientUdpSocketReleasedBeforeProcessExit':socketReleased,'native':{k:v for k,v in observations.items() if k not in ['closedAt','cleanupAt']},'stderrPresent':bool(stderr),'liveSpryContacted':False,'syntheticCredentialsOnly':True}
 result['passed']=result['exitCode']==0 and result['refreshZeroRequests']>0 and result['clientUdpSocketReleasedBeforeProcessExit'] is True
 print(json.dumps(result))
finally:
 if child.poll() is None:child.kill();child.wait()
 sock.close()

raise SystemExit(0 if result["passed"] else 1)
