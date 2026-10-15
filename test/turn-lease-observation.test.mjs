import test from "node:test";
import assert from "node:assert/strict";
import { createTurnCredentials } from "../demo/turn-credentials.mjs";
import { createTurnCredentials as createBaseline } from "./fixtures/turn-credentials-before-lease-observation.mjs";
const descriptor={v:1,endpoint:"/turn-credentials",method:"POST"};
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const payload=(serverTime=900000000)=>({v:1,iceServers:[{urls:["turns:example.invalid:5349?transport=tcp"],username:"fake-user",credential:"fake-secret"}],ttlSeconds:3600,issuedAt:900000000,expiresAt:903600000,refreshAt:902400000,serverTime});
const json=value=>new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
function fixture(factory=createTurnCredentials){
 let mono=7000000,wall=1000000,id=0,reply,wallHook,body;
 const trace=[],timers=new Map();
 const client=factory({origin:"https://viewer.test",now(){trace.push(["now",mono]);return mono;},wallNow(){trace.push(["wall",wall]);const hook=wallHook;wallHook=null;hook?.();return wall;},
  setTimer(fn,ms){trace.push(["set",ms]);timers.set(++id,{fn,ms});return id;},clearTimer(key){trace.push(["clear",key??null]);timers.delete(key);},
  fetchImpl(){trace.push(["fetch"]);return new Promise(resolve=>{reply=resolve;});},onRefresh(){trace.push(["refresh"]);},onUnavailable(reason){trace.push(["unavailable",reason]);}});
 return{client,trace,timers,jump(ms){mono+=ms;wall+=ms;},hook(fn){wallHook=fn;},respond(value=payload()){reply(json(value));},
  partial(value=payload()){const bytes=new TextEncoder().encode(JSON.stringify(value));reply(new Response(new ReadableStream({start(controller){body=controller;controller.enqueue(bytes.slice(0,10));}}),{headers:{"content-type":"application/json"}}));return()=>{body.enqueue(bytes.slice(10));body.close();};},
  fireRefresh(){const [key,row]=[...timers].sort((a,b)=>a[1].ms-b[1].ms)[0];mono+=row.ms;wall+=row.ms;timers.delete(key);row.fn();}};
}
function core(snapshot){const{authorityEpoch,lease,...rest}=snapshot;return rest;}
async function differential(factory,barrier){
 const f=fixture(factory);f.client.configure(descriptor,"session");const acquiring=f.client.acquire();await flush();f.jump(300);
 if(barrier)f.hook(()=>{if(barrier==="closed")f.client.close();else if(barrier==="inactive")f.client.setActive(false);else{f.client.configure(descriptor,"replacement");f.client.setActive(true);}});
 f.respond();const accepted=await acquiring;const snapshot=core(f.client.snapshot());f.client.close();
 return{accepted,snapshot,trace:f.trace};
}
test("late boundary waits a full rawTTL after complete response, independent of issuer clock",async()=>{
 const f=fixture();f.client.configure(descriptor,"session");const acquiring=f.client.acquire();await flush();let settled=false;acquiring.then(()=>{settled=true;});
 f.jump(200);const finish=f.partial(payload(900000450));await flush();assert.equal(settled,false);assert.equal(f.client.snapshot().lease,null);
 f.jump(300);finish();assert.equal(await acquiring,true);const lease=f.client.snapshot().lease;
 assert.equal(lease.requestStartedMonotonicMs,7000000);assert.equal(lease.responseObservedMonotonicMs,7000500);
 assert.equal(lease.expiresAtMonotonicMs,10599550);assert.equal(lease.fullTtlAfterResponseMonotonicMs,10600500);
 assert.equal(lease.fullTtlAfterResponseMonotonicMs-lease.responseObservedMonotonicMs,3600000);
 assert(lease.fullTtlAfterResponseMonotonicMs>lease.expiresAtMonotonicMs);f.client.close();
});
test("successful acceptance retains baseline clock calls, order, timers and operational result",async()=>{
 const baseline=await differential(createBaseline),observed=await differential(createTurnCredentials);
 assert.equal(observed.accepted,true);assert.deepEqual(observed,baseline);
});
test("closed inactive and generation-fenced short circuits add no clock calls or authority",async()=>{
 for(const barrier of ["closed","inactive","generation"]){
  const baseline=await differential(createBaseline,barrier),observed=await differential(createTurnCredentials,barrier);
  assert.equal(observed.accepted,false,barrier);assert.deepEqual(observed,baseline,barrier);
 }
});
test("cached identical credentials retain both original response anchors and the entire lease",async()=>{
 const f=fixture();f.client.configure(descriptor,"session");const acquiring=f.client.acquire();await flush();f.jump(100);f.respond();assert.equal(await acquiring,true);
 const before=f.client.snapshot().lease;assert.equal(before.responseObservedMonotonicMs,7000100);assert.equal(before.fullTtlAfterResponseMonotonicMs,10600100);
 f.fireRefresh();await flush();f.jump(200);f.respond(payload(902400000));await flush();
 assert.deepEqual(f.client.snapshot().lease,before);assert.equal(f.client.snapshot().refreshes,1);f.client.close();
});
