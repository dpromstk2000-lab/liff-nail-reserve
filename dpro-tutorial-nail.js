/** DPRO TUTORIAL NAIL / STANDARD V1.1 / R3 */
(()=>{
  'use strict';
  const VERSION='1.1';
  const SYSTEM='NAIL';
  const STORAGE_KEY='dpro_tutorial_nail_v1_1_progress';
  const GUIDE_MODE=new URLSearchParams(location.search).get('guide')==='1';
  const MAP=Object.freeze([
    {n:1,route:'demo-guide.html',target:'section.hero',title:'ネイルサロン業務を4画面で確認',body:'予約、会員ページ、店頭iPad、オーナー管理を順番に見る公開デモです。'},
    {n:2,route:'demo-guide.html',target:'.notice',title:'デモでは架空情報だけを使用',body:'実在する氏名・電話番号・アレルギー情報・爪の状態・施術写真は使いません。店舗側デモ管理コードは1234です。'},
    {n:3,route:'index.html',target:'#stepMethod',title:'予約内容の選び方',body:'写真付きデザイン、メニュー、前回と同じ内容から予約の入口を選びます。'},
    {n:4,route:'index.html',target:'#stepDetail',title:'オフ・長さ出し・補強',body:'追加内容が施術時間と空き枠へ影響する場所です。Tutorialでは値を保存しません。'},
    {n:5,route:'index.html',target:'#stepStaff',title:'担当ネイリスト',body:'指名あり・指名なしを選ぶ場所です。Tutorialでは担当確定や予約送信を行いません。'},
    {n:6,route:'index.html',target:'#stepDate',title:'日付と30分単位の時間枠',body:'営業日を選び、その後の時間画面で空き枠を確認します。ここでは日時確定や予約送信はしません。'},
    {n:7,route:'index.html',target:'#stepInfo',title:'お客様情報と最終確認',body:'名前・電話番号・相談内容を入力し、次の確認画面から予約送信します。First10では送信ボタンを押さず、機能説明だけで次へ進みます。'},
    {n:8,route:'member.html',target:'#reservations',title:'会員ページで予約と履歴を確認',body:'予約確認・変更・キャンセル、施術履歴、次回来店目安、前回と同じ再予約の入口を確認します。Tutorialでは変更・キャンセル・再予約を実行しません。'},
    {n:9,route:'owner-ipad.html',target:'#view-today',title:'店頭iPadで来店からカルテまで',body:'本日の予約、来店、施術開始、施術カルテ、写真、会計、次回予約が同じ画面につながっています。管理コード1234は既存デモログインにのみ使います。'},
    {n:10,route:'owner.html',target:'#view-dashboard',title:'オーナー管理で全体を確認',body:'ダッシュボードから本日の施術、顧客・カルテ、再来店フォロー、デザイン、電話・店頭予約、店舗設定へ移動できます。これでFirst10は完了です。'}
  ]);
  window.DPRO_NAIL_TUTORIAL_MAP=MAP;
  window.DPRO_NAIL_TUTORIAL_VERSION=VERSION;
  if(GUIDE_MODE) return;

  const $=s=>document.querySelector(s);
  const route=()=>{if(location.pathname.endsWith('/'))return 'index.html';const p=location.pathname.split('/').filter(Boolean).pop()||'index.html';return p;};
  const defaultState=()=>({version:VERSION,currentStep:1,completed:false,skipped:false,closed:true,lastRoute:route(),cardPosition:null});
  let state=loadState();
  let card=null,highlight=null,launcher=null,currentTarget=null,drag=null;

  function loadState(){
    try{const x=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');if(x&&x.version===VERSION&&Number.isInteger(x.currentStep)&&x.currentStep>=1&&x.currentStep<=10)return {...defaultState(),...x};}catch(_){ }
    return defaultState();
  }
  function saveState(){state.lastRoute=route();localStorage.setItem(STORAGE_KEY,JSON.stringify(state));}
  function clearTransient(){document.querySelectorAll('.dpro-tutorial-transient').forEach(el=>el.classList.remove('dpro-tutorial-transient'));document.querySelectorAll('.dpro-tutorial-transient-login').forEach(el=>el.classList.remove('dpro-tutorial-transient-login'));}
  function expected(step){return MAP[step-1];}
  function validRouteFor(step){const item=expected(step);return item&&route()===item.route;}
  function navigationUrl(step){const item=expected(step);const u=new URL(item.route,location.href);u.searchParams.set('tutorial','nail');u.searchParams.set('step',String(step));return u.toString();}
  function parseMarker(){const p=new URLSearchParams(location.search);if(p.get('tutorial')!=='nail')return 0;const n=Number(p.get('step'));return Number.isInteger(n)&&n>=1&&n<=10?n:0;}

  function buildUi(){
    if($('#dproTutorialNailCard')) return;
    highlight=document.createElement('div');highlight.className='dpro-tutorial-highlight';highlight.id='dproTutorialNailHighlight';document.body.appendChild(highlight);
    launcher=document.createElement('button');launcher.id='dproTutorialNailLauncher';launcher.type='button';launcher.textContent='First10 ガイド';launcher.addEventListener('click',()=>resumeTutorial());document.body.appendChild(launcher);
    card=document.createElement('section');card.id='dproTutorialNailCard';card.className='dpro-tutorial-card';card.hidden=true;card.setAttribute('role','dialog');card.setAttribute('aria-modal','false');card.setAttribute('aria-labelledby','dproTutorialNailTitle');
    card.innerHTML=`<div class="dpro-tutorial-drag-handle" id="dproTutorialNailHandle" tabindex="0" role="button" aria-label="Tutorialカードを移動"><span>FIRST10 / ${SYSTEM}</span><span class="dpro-tutorial-drag-dots" aria-hidden="true">⠿</span></div><div class="dpro-tutorial-body"><div class="dpro-tutorial-kicker" id="dproTutorialNailKicker"></div><h2 id="dproTutorialNailTitle" tabindex="-1"></h2><p id="dproTutorialNailText"></p><div class="dpro-tutorial-progress" aria-hidden="true"><span id="dproTutorialNailProgress"></span></div><div class="dpro-tutorial-route" id="dproTutorialNailRoute"></div><div id="dproTutorialNailComplete" class="dpro-tutorial-complete" hidden></div></div><div class="dpro-tutorial-actions"><button type="button" class="dpro-back" id="dproTutorialNailBack">戻る</button><button type="button" class="dpro-next" id="dproTutorialNailNext">次へ</button><button type="button" class="dpro-skip" id="dproTutorialNailSkip">スキップ</button></div>`;
    document.body.appendChild(card);
    $('#dproTutorialNailBack').addEventListener('click',back);
    $('#dproTutorialNailNext').addEventListener('click',next);
    $('#dproTutorialNailSkip').addEventListener('click',skip);
    const handle=$('#dproTutorialNailHandle');
    handle.addEventListener('pointerdown',startDrag);handle.addEventListener('pointermove',moveDrag);handle.addEventListener('pointerup',endDrag);handle.addEventListener('pointercancel',endDrag);
    window.addEventListener('resize',()=>{clampCard();updateHighlight();},{passive:true});window.addEventListener('orientationchange',()=>setTimeout(()=>{clampCard();updateHighlight();},80),{passive:true});window.addEventListener('scroll',updateHighlight,{passive:true});
    if(window.visualViewport){visualViewport.addEventListener('resize',()=>{clampCard();updateHighlight();},{passive:true});visualViewport.addEventListener('scroll',updateHighlight,{passive:true});}
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!card.hidden){e.preventDefault();closeTutorial();}});
    refreshLauncher();
  }

  function viewport(){return {w:window.visualViewport?.width||innerWidth,h:window.visualViewport?.height||innerHeight};}
  function clampCard(){if(!card||card.hidden)return;const v=viewport(),r=card.getBoundingClientRect(),pad=8;let x=parseFloat(card.style.left),y=parseFloat(card.style.top);if(!Number.isFinite(x))x=Math.max(pad,v.w-r.width-pad);if(!Number.isFinite(y))y=Math.max(pad,v.h-r.height-pad);x=Math.min(Math.max(pad,x),Math.max(pad,v.w-r.width-pad));y=Math.min(Math.max(pad,y),Math.max(pad,v.h-r.height-pad));card.style.left=`${Math.round(x)}px`;card.style.top=`${Math.round(y)}px`;card.style.right='auto';card.style.bottom='auto';state.cardPosition={x:Math.round(x),y:Math.round(y)};saveState();}
  function restoreCardPosition(){const v=viewport(),r=card.getBoundingClientRect(),pad=8;let x=state.cardPosition?.x,y=state.cardPosition?.y;if(!Number.isFinite(x))x=Math.max(pad,v.w-r.width-pad);if(!Number.isFinite(y))y=Math.max(pad,v.h-r.height-pad);card.style.left=`${x}px`;card.style.top=`${y}px`;card.style.right='auto';card.style.bottom='auto';clampCard();}
  function startDrag(e){if(e.button!==undefined&&e.button!==0)return;const r=card.getBoundingClientRect();drag={id:e.pointerId,dx:e.clientX-r.left,dy:e.clientY-r.top};e.currentTarget.setPointerCapture?.(e.pointerId);e.preventDefault();}
  function moveDrag(e){if(!drag||drag.id!==e.pointerId)return;card.style.left=`${e.clientX-drag.dx}px`;card.style.top=`${e.clientY-drag.dy}px`;clampCard();e.preventDefault();}
  function endDrag(e){if(!drag||drag.id!==e.pointerId)return;drag=null;try{e.currentTarget.releasePointerCapture?.(e.pointerId);}catch(_){ }clampCard();saveState();}

  async function ensureReadOnlyEntrance(step){
    const demo=window.DPRO_NAIL_PR1?.demo!==false;
    if(!demo)return;
    if(step===9){const login=$('#loginScreen');const input=$('#loginCode');if(input)input.value='1234';if(login&&!login.classList.contains('hidden'))login.classList.add('dpro-tutorial-transient-login');}
    if(step===10){const unlock=$('#unlock');const input=$('#unlockCode');if(input)input.value='1234';if(unlock&&!unlock.classList.contains('hidden'))unlock.classList.add('dpro-tutorial-transient-login');}
  }

  async function prepareTarget(step){
    clearTransient();await ensureReadOnlyEntrance(step);const item=expected(step);let target=$(item.target);if(!target)return null;
    if(target.classList.contains('hidden'))target.classList.add('dpro-tutorial-transient');
    if(step>=3&&step<=7)target.classList.add('dpro-tutorial-transient');
    target.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'});currentTarget=target;updateHighlight();return target;
  }
  function updateHighlight(){if(!highlight||!currentTarget||card?.hidden){if(highlight)highlight.style.display='none';return;}const r=currentTarget.getBoundingClientRect();if(r.width<=0||r.height<=0){highlight.style.display='none';return;}const pad=5;highlight.style.display='block';highlight.style.left=`${Math.max(2,r.left-pad)}px`;highlight.style.top=`${Math.max(2,r.top-pad)}px`;highlight.style.width=`${Math.max(8,Math.min(innerWidth-4,r.width+pad*2))}px`;highlight.style.height=`${Math.max(8,Math.min(innerHeight-4,r.height+pad*2))}px`;}

  async function renderStep(step,{focus=true}={}){
    const item=expected(step);if(!item)return;
    state.currentStep=step;state.completed=false;state.skipped=false;state.closed=false;saveState();
    if(!validRouteFor(step)){location.href=navigationUrl(step);return;}
    {const u=new URL(location.href);u.searchParams.set('tutorial','nail');u.searchParams.set('step',String(step));history.replaceState(null,'',u.toString());}
    card.hidden=false;launcher.hidden=true;$('#dproTutorialNailComplete').hidden=true;$('#dproTutorialNailKicker').textContent=`STEP ${String(step).padStart(2,'0')} / 10`;$('#dproTutorialNailTitle').textContent=item.title;$('#dproTutorialNailText').textContent=item.body;$('#dproTutorialNailProgress').style.width=`${step*10}%`;$('#dproTutorialNailRoute').textContent=`${item.route}  ·  ${item.target}`;$('#dproTutorialNailBack').disabled=step===1;$('#dproTutorialNailNext').textContent=step===10?'完了':'次へ';$('#dproTutorialNailSkip').hidden=false;$('#dproTutorialNailSkip').textContent='スキップ';
    await prepareTarget(step);restoreCardPosition();requestAnimationFrame(()=>{clampCard();updateHighlight();});if(focus)$('#dproTutorialNailTitle').focus({preventScroll:true});
  }
  function showComplete(){clearTransient();currentTarget=null;updateHighlight();state.completed=true;state.closed=false;state.skipped=false;state.currentStep=10;saveState();card.hidden=false;launcher.hidden=true;$('#dproTutorialNailKicker').textContent='FIRST10 COMPLETE';$('#dproTutorialNailTitle').textContent='First10 完了';$('#dproTutorialNailText').textContent='10ステップの確認が完了しました。業務データは変更していません。';$('#dproTutorialNailProgress').style.width='100%';$('#dproTutorialNailRoute').textContent='business mutation 0';$('#dproTutorialNailBack').disabled=false;$('#dproTutorialNailNext').textContent='もう一度';$('#dproTutorialNailSkip').textContent='閉じる';$('#dproTutorialNailComplete').hidden=false;$('#dproTutorialNailComplete').innerHTML='<strong>✓ 完了</strong><p>ReplayするとTutorial進捗だけを初期化します。</p>';$('#dproTutorialNailTitle').focus({preventScroll:true});clampCard();}
  function next(){if(state.completed){replay();return;}if(state.currentStep>=10){showComplete();return;}renderStep(state.currentStep+1);}
  function back(){if(state.completed){state.completed=false;renderStep(10);return;}if(state.currentStep<=1)return;renderStep(state.currentStep-1);}
  function closeTutorial(){state.closed=true;saveState();card.hidden=true;highlight.style.display='none';clearTransient();currentTarget=null;refreshLauncher();launcher.hidden=false;launcher.focus();}
  function skip(){if(state.completed){closeTutorial();return;}state.skipped=true;state.closed=true;saveState();card.hidden=true;highlight.style.display='none';clearTransient();currentTarget=null;refreshLauncher();launcher.hidden=false;launcher.focus();}
  function replay(){localStorage.removeItem(STORAGE_KEY);state=defaultState();state.closed=false;saveState();renderStep(1);}
  function resumeTutorial(){if(state.completed||state.skipped){replay();return;}state.closed=false;saveState();renderStep(state.currentStep||1);}
  function refreshLauncher(){if(!launcher)return;launcher.textContent=state.completed?'First10 をもう一度':state.skipped?'First10 を再開':state.currentStep>1?'First10 を再開':'First10 ガイド';}

  document.addEventListener('DOMContentLoaded',()=>{
    buildUi();const marker=parseMarker();if(marker&&validRouteFor(marker)){state.currentStep=marker;state.closed=false;state.skipped=false;saveState();renderStep(marker);}else{refreshLauncher();if(!state.closed&&!state.skipped&&!state.completed&&validRouteFor(state.currentStep))renderStep(state.currentStep,{focus:false});}
  },{once:true});
  window.DPRO_NAIL_TUTORIAL=Object.freeze({version:VERSION,map:MAP,start:()=>replay(),resume:()=>resumeTutorial(),close:()=>closeTutorial(),state:()=>({...state})});
})();
