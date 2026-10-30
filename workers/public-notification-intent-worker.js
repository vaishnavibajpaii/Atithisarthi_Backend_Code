"use strict";
const{env}=require("../config/env"),{supabase}=require("../utils/supabase");
const logger=require("../utils/logger"),{metrics}=require("../utils/operational-metrics");
const{publishNotificationEvent}=require("../utils/notification-live");
const{processNotificationEventDelivery}=require("../utils/notifications");
const{createPublicNotificationIntentProcessor}=require("../utils/public-notification-intent-processor");
let timer=null;
async function rpc(name,args){const{data,error}=await supabase.rpc(name,args);if(error)throw error;return data;}
const processor=createPublicNotificationIntentProcessor({
  list:(count)=>rpc("task7d_list_public_notification_intents",{p_limit:count}),
  deliver:(event)=>processNotificationEventDelivery(event,{databaseClient:supabase}),
  ack:(id)=>rpc("task7d_ack_public_notification_intent",{p_event_id:String(id)}),
  publish:publishNotificationEvent,metrics,logger
});
function startPublicNotificationIntentWorker(){
  const enabled=env.task7PublicNotificationOutboxEnabled&&env.task7NotificationLeasesEnabled&&env.tenantRuntimeWritesEnabled;
  metrics.worker("public_notification_intents",{enabled});
  if(!enabled||timer)return timer;
  const run=()=>{void processor.processBatch().catch(()=>logger.warn("Public notification intent cycle failed",{errorCode:"PUBLIC_NOTIFICATION_INTENT_BATCH_FAILED"}));};
  timer=setInterval(run,2000);timer.unref?.();run();return timer;
}
function stopPublicNotificationIntentWorker(){if(timer){clearInterval(timer);timer=null;}metrics.worker("public_notification_intents",{enabled:false,running:processor.isProcessing()});}
module.exports={startPublicNotificationIntentWorker,stopPublicNotificationIntentWorker};
