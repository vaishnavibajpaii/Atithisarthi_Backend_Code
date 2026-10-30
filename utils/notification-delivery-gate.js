"use strict";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES=new Set(["order","reservation","inquiry","contact_submission","testimonial","support_request"]);
const code=(value)=>Object.assign(new Error(value),{code:value});
const integer=(value)=>!(typeof value==="number"&&!Number.isSafeInteger(value))&&/^[1-9]\d*$/.test(String(value??""));
const same=(left,right)=>String(left)===String(right);
function validate(event){if(!event||!integer(event.id)||!UUID.test(event.tenant_id||"")||!integer(event.property_id)||
  typeof event.hotel_slug!=="string"||!event.hotel_slug||event.hotel_slug.trim()!==event.hotel_slug||
  !TYPES.has(event.source_type)||!event.source_id||!["string","number"].includes(typeof event.source_id)||
  (typeof event.source_id==="number"&&!Number.isSafeInteger(event.source_id))||
  (typeof event.source_id==="string"&&(!event.source_id.trim()||event.source_id!==event.source_id.trim()))||
  typeof event.event_type!=="string"||!event.event_type)throw code("NOTIFICATION_DELIVERY_SCOPE_INVALID");}
function bind(actual,expected){validate(actual);if(!["id","tenant_id","property_id","hotel_slug","source_type","source_id","event_type"].every((field)=>same(actual[field],expected[field])))throw code("NOTIFICATION_DELIVERY_SCOPE_INVALID");}
function publicEvent(event){const{_task7Lease,...result}=event;return result;}

function createNotificationDeliveryGate({leaseStore,perform,logger={warn(){}}}){
  return async function deliver(notificationEvent,options={}){
    validate(notificationEvent);
    let admission;
    try{admission=await leaseStore.claim(notificationEvent,options.manualResend);}
    catch{throw code("NOTIFICATION_DELIVERY_ADMISSION_FAILED");}
    if(admission.admission==="terminal"){
      bind(admission.event,notificationEvent);
      if(!["sent","skipped"].includes(admission.event.status)||options.manualResend)throw code("NOTIFICATION_DELIVERY_CONTRACT_INVALID");
      return publicEvent(admission.event);
    }
    if(admission.admission!=="claimed"){
      const allowed=new Set(["disabled","historical_excluded","busy_or_scope","retry_later","retry_exhausted","stale_admin","admin_limit"]);
      throw code(allowed.has(admission.admission)?"NOTIFICATION_DELIVERY_"+admission.admission.toUpperCase():"NOTIFICATION_DELIVERY_CONTRACT_INVALID");
    }
    const claimed=admission.event;let watch;
    try{
      bind(claimed,notificationEvent);
      if(!["pending","failed"].includes(claimed.status))throw code("NOTIFICATION_DELIVERY_CONTRACT_INVALID");
      watch=leaseStore.watch(claimed);await watch.assertOwned();
      const outcome=await perform(publicEvent(claimed),options,{
        signal:watch.signal,assertOwned:()=>watch.assertOwned()
      });
      if(!outcome||!["sent","skipped","failed"].includes(outcome.status))throw code("NOTIFICATION_DELIVERY_CONTRACT_INVALID");
      await watch.assertOwned();
      const completed=await leaseStore.complete(claimed,outcome.status,outcome.errorMessage??null);
      if(!completed)throw code("NOTIFICATION_DELIVERY_LEASE_LOST");
      bind(completed,notificationEvent);
      if(completed.status!==outcome.status)throw code("NOTIFICATION_DELIVERY_CONTRACT_INVALID");
      return publicEvent(completed);
    }catch(error){
      // A lost/unknown lease cannot authorize a second status write. Otherwise a
      // pre-effect failure can release this exact claim with a bounded category.
      const ownershipLost=watch?.signal?.aborted||error?.code==="NOTIFICATION_DELIVERY_LEASE_LOST";
      if(!ownershipLost){
        try{await leaseStore.complete(claimed,"failed","NOTIFICATION_DELIVERY_EFFECT_FAILED");}
        catch{logger.warn("Notification lease failure could not be recorded",{errorCode:"NOTIFICATION_DELIVERY_FAILURE_WRITE_FAILED"});}
      }
      throw code(ownershipLost?"NOTIFICATION_DELIVERY_LEASE_LOST":/^NOTIFICATION_DELIVERY_[A-Z_]{1,64}$/.test(error?.code||"")?error.code:"NOTIFICATION_DELIVERY_EFFECT_FAILED");
    }finally{watch?.stop();}
  };
}
module.exports={createNotificationDeliveryGate};
