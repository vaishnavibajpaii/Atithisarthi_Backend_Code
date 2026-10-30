"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {verifyPublicTestimonialsEligibility,verifyPublicTestimonialsSourceContract}=require("../scripts/verify-review-notification-workflow");
const {buildPublicTestimonialsPayload}=require("../utils/public-testimonials-presentation");
const route=fs.readFileSync(path.join(__dirname,"../routes/public.js"),"utf8"),tenant=fs.readFileSync(path.join(__dirname,"../utils/tenant-public-testimonials.js"),"utf8");

test("notification workflow verifier exercises the real public testimonial presenter",()=>{verifyPublicTestimonialsEligibility();verifyPublicTestimonialsSourceContract(route,tenant);});
test("public eligibility verification rejects presenters that leak hidden or incomplete reviews",()=>{
  for(const id of ["not-approved","missing-approval","string-approval","numeric-approval","archived","inactive","empty-name","empty-review"]){
    assert.throws(()=>verifyPublicTestimonialsEligibility((rows,slug)=>{
      const result=buildPublicTestimonialsPayload(rows,slug);
      if(Array.isArray(rows)&&rows.some(row=>row?.id===id))result.testimonials.push({id});
      return result;
    }),{code:"ERR_ASSERTION"});
  }
});
test("route delegation and canonical tenant/legacy approval filters are mandatory",()=>{
  for(const [from,to]of [
    ['require("../utils/public-testimonials-presentation")','require("../utils/other-presenter")'],
    ['const payload = buildPublicTestimonialsPayload(','const payload = buildUnfilteredPayload('],
    ['.eq("is_approved", true)','.eq("is_approved", false)'],
    ['.eq("is_active", true)','.eq("is_active", false)'],
    ['.eq("is_archived", false)','.eq("is_archived", true)']
  ])assert.throws(()=>verifyPublicTestimonialsSourceContract(route.replaceAll(from,to),tenant),{code:"ERR_ASSERTION"});
  for(const from of ['item.tenant_id = $1::uuid','item.property_id = $2::bigint','item.hotel_slug = $3','item.is_archived = false','item.is_active = true','item.is_approved = true'])assert.throws(()=>verifyPublicTestimonialsSourceContract(route,tenant.replace(from,"true")),{code:"ERR_ASSERTION"});
});
