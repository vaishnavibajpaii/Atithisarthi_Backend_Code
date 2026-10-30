"use strict";
const {randomUUID}=require("node:crypto");
const fail=()=>Object.assign(new Error("NOTIFICATION_DELIVERY_LEASE_LOST"),{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});

// Internal delivery broker only. Never replaces a caller's tenant CRUD adapter.
class NotificationDeliveryLeaseStore {
  constructor(workerClient,{leaseSeconds=60,heartbeatMs=10000}={}){
    if(!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>300||!Number.isInteger(heartbeatMs)||heartbeatMs<1000||heartbeatMs>=leaseSeconds*500)throw new Error("NOTIFICATION_LEASE_CONFIG_INVALID");
    this.db=workerClient;this.leaseSeconds=leaseSeconds;this.heartbeatMs=heartbeatMs;
  }
  async rpc(name,args={}){const{data,error}=await this.db.rpc(name,args);if(error)throw error;return data;}
  async claim(event,manualResend){
    const owner=randomUUID();
    const result=await this.rpc("task7d_claim_notification_delivery",{p_event_id:String(event.id),p_tenant_id:event.tenant_id,
      p_property_id:String(event.property_id),p_hotel_slug:event.hotel_slug,p_lease_owner:owner,
      p_mode:manualResend?"admin":"auto",p_expected_status:manualResend?.expectedStatus??null,
      p_expected_retry:manualResend?.expectedRetry??null,p_lease_seconds:this.leaseSeconds});
    if(!result||typeof result.admission!=="string")throw fail();
    if(result.admission!=="claimed")return result;
    if(!result.event||result.lease?.owner!==owner||typeof result.lease.version!=="string"||!/^[1-9]\d*$/.test(result.lease.version))throw fail();
    return {...result,event:{...result.event,_task7Lease:result.lease}};
  }
  args(event){if(!event?._task7Lease)throw fail();return{p_event_id:String(event.id),p_lease_owner:event._task7Lease.owner,p_claim_version:String(event._task7Lease.version)};}
  async renew(event){return(await this.rpc("task7d_renew_notification_delivery",{...this.args(event),p_lease_seconds:this.leaseSeconds}))===true;}
  async complete(event,status,errorMessage=null){return this.rpc("task7d_complete_notification_delivery",{...this.args(event),p_status:status,p_error_message:errorMessage});}
  watch(event){
    let stopped=false,lost=false,inFlight,expiryTimer;
    const controller=new AbortController();
    // Start the local budget before each RPC, so a delayed response cannot
    // extend ownership beyond the database lease. Leave five seconds of margin.
    const budget=(this.leaseSeconds-5)*1000;
    const lose=()=>{if(lost)return;lost=true;clearTimeout(expiryTimer);controller.abort(fail());};
    const arm=(started)=>{
      clearTimeout(expiryTimer);
      const remaining=budget-(performance.now()-started);
      if(remaining<=0){lose();return;}
      expiryTimer=setTimeout(lose,remaining);expiryTimer.unref?.();
    };
    arm(performance.now());
    const refresh=()=>{
      if(stopped||lost)return Promise.resolve(false);
      if(inFlight)return inFlight;
      const started=performance.now();
      inFlight=Promise.resolve().then(()=>this.renew(event)).then((ok)=>{
        if(!ok||stopped||lost){if(!stopped)lose();return false;}
        arm(started);return !lost;
      },()=>{lose();return false;}).finally(()=>{inFlight=undefined;});
      return inFlight;
    };
    const timer=setInterval(()=>{void refresh();},this.heartbeatMs);timer.unref?.();
    return{signal:controller.signal,
      stop(){stopped=true;clearInterval(timer);clearTimeout(expiryTimer);controller.abort(fail());},
      assertOwned:async()=>{
        if(stopped||lost)throw fail();
        let onAbort;
        const aborted=new Promise((resolve)=>{onAbort=()=>resolve(false);controller.signal.addEventListener("abort",onAbort,{once:true});});
        try{if(!await Promise.race([refresh(),aborted])||stopped||lost)throw fail();}
        finally{controller.signal.removeEventListener("abort",onAbort);}
      }};
  }
}
module.exports={NotificationDeliveryLeaseStore};
