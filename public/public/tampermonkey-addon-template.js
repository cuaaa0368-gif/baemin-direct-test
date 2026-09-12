/* 기존 스크립트의 마지막 })(); 바로 위에 추가
   지사마다 CENTER_KEY / CENTER_NAME만 다르게 설정 */
const RC_SERVER_URL='https://YOUR-SERVER.example';
const RC_INGEST_KEY='change-me-later';
const RC_CENTER_KEY='gangnam';
const RC_CENTER_NAME='강남';

async function pushRiderControlLive(){
 if(!CENTER_ID)return;
 try{
  const {list,total}=await fetchAll();
  const peaks={morning:0,afternoon:0,evening:0,night:0};
  list.forEach(d=>{const p=d.deliveryPeakTimeCount||{};peaks.morning+=safe(p.morning);peaks.afternoon+=safe(p.afternoon);peaks.evening+=safe(p.evening);peaks.night+=safe(p.midnight)});
  const completed=safe(total?.totalFoodCompleted), rejected=safe(total?.totalFoodRejected), canceled=safe(total?.totalFoodCanceled), riderFault=safe(total?.totalFoodRiderFault);
  const denom=completed+rejected+canceled+riderFault;
  const riders=list.map(d=>({name:mapName(d.name),phoneNumber:d.phoneNumber||'',userId:d.userId||'',status:d.status?.code||'',allDayComplete:safe(d.deliveryAcceptanceCount?.allDayComplete),foodComplete:safe(d.deliveryAcceptanceCount?.foodComplete),foodReject:safe(d.deliveryAcceptanceCount?.foodReject),morning:safe(d.deliveryPeakTimeCount?.morning),afternoon:safe(d.deliveryPeakTimeCount?.afternoon),evening:safe(d.deliveryPeakTimeCount?.evening),night:safe(d.deliveryPeakTimeCount?.midnight)}));
  const ranking=riders.filter(r=>r.allDayComplete>0).sort((a,b)=>b.allDayComplete-a.allDayComplete).map(r=>({name:r.name,val:r.allDayComplete}));
  await fetch(`${RC_SERVER_URL}/api/ingest/${encodeURIComponent(RC_CENTER_KEY)}`,{method:'POST',headers:{'Content-Type':'application/json','x-ingest-key':RC_INGEST_KEY},body:JSON.stringify({centerName:RC_CENTER_NAME,sentAt:new Date().toISOString(),summary:{runCount:list.filter(d=>d.status?.code==='DELIVERING').length+getManualRunnerOffset(),completed,rejectRate:denom?(((rejected+canceled+riderFault)/denom)*100).toFixed(2):'0.00'},peaks,goals:{morning:getGoal('morning'),afternoon:getGoal('afternoon'),evening:getGoal('evening'),night:getGoal('night')},ranking,riders})});
 }catch(e){console.warn('[RiderControl] 전송 실패',e)}
}
setInterval(pushRiderControlLive,10000);setTimeout(pushRiderControlLive,5000);
