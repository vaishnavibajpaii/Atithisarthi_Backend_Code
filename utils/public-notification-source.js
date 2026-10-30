"use strict";
const {env}=require("../config/env");
const {publishNotificationEvent}=require("./notification-live");
const logger=require("./logger");
const TABLES={reservation:"reservations",inquiry:"inquiries",contact_submission:"contact_submissions"};
const RPC="task7d_create_public_source_with_intent";
const failure=(code)=>({data:null,error:{code,message:code},intentPersisted:false});
const same=(left,right)=>String(left)===String(right);
const id=value=>!(typeof value==="number"&&!Number.isSafeInteger(value))&&/^[1-9]\d*$/.test(String(value??""));
function unwrap(value){
  if(Array.isArray(value)){if(value.length!==1)return null;value=value[0];}
  return value?.[RPC]||value;
}
async function insertPublicNotificationSource({databaseClient,sourceType,record}){
  const table=TABLES[sourceType];
  if(!table)return failure("PUBLIC_NOTIFICATION_SOURCE_INVALID");
  if(!env.task7PublicNotificationOutboxEnabled){
    return{...await databaseClient.from(table).insert([record]).select().single(),intentPersisted:false};
  }
  if(!env.tenantRuntimeWritesEnabled||!env.task7NotificationLeasesEnabled)return failure("PUBLIC_NOTIFICATION_OUTBOX_PREREQUISITES_REQUIRED");
  const result=await databaseClient.rpc(RPC,{p_source_type:sourceType,p_source:record}).single();
  if(result.error)return{...result,intentPersisted:false};
  const data=unwrap(result.data),source=data?.source_record,notification=data?.notification_event;
  if(!source||!notification||!id(source.id)||!id(notification.id)||!id(source.property_id)||
    !["tenant_id","property_id","hotel_slug"].every(key=>same(source[key],record[key])&&same(notification[key],record[key]))||
    notification.source_type!==sourceType||notification.event_type!==sourceType+"_created"||!same(notification.source_id,source.id)||!notification.payload||typeof notification.payload!=="object"||Array.isArray(notification.payload)){
    return failure("PUBLIC_NOTIFICATION_OUTBOX_RESULT_INVALID");
  }
  // The RPC has committed business, card and explicit intent before publication.
  try{publishNotificationEvent(notification);}catch{logger.warn("Public notification publication deferred to polling",{errorCode:"PUBLIC_NOTIFICATION_LOCAL_PUBLICATION_FAILED"});}
  return{data:source,error:null,intentPersisted:true};
}
module.exports={insertPublicNotificationSource};
