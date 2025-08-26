// main.js
const fileA = document.getElementById('fileA');
const fileB = document.getElementById('fileB');
const runHeavy = document.getElementById('runHeavy');
const runGate = document.getElementById('runGate');
const status = document.getElementById('status');
const summary = document.getElementById('summary');
const details = document.getElementById('details');
const canvasOverlay = document.getElementById('canvasOverlay');

let worker;

function setStatus(t){ status.innerText = t; }

function startWorker(){
  if (worker) worker.terminate();
  worker = new Worker('js/worker-diff.js');
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') setStatus(msg.text);
    else if (msg.type === 'error') {
      setStatus('خطأ: '+msg.text);
      console.error(msg); 
    }
    else if (msg.type === 'result') renderResult(msg.payload);
  };
}

runGate.addEventListener('click', async ()=>{
  // فحص مبدئي سريع: مقارنة الأبعاد + OCR سريع (نص قصير)
  if (!fileA.files[0] || !fileB.files[0]) { setStatus('رفع الملفين مطلوب'); return; }
  setStatus('جارٍ الفحص المبدئي...');
  const abA = await fileToArrayBuffer(fileA.files[0]);
  const abB = await fileToArrayBuffer(fileB.files[0]);
  // مقارنة الحجم التقريبي
  if (abA.byteLength !== abB.byteLength) setStatus('حجم الملفات يختلف — احتمال تغيير');
  else setStatus('الحجم متقارب — لا استنتاج نهائي');
});

runHeavy.addEventListener('click', async ()=>{
  if (!fileA.files[0] || !fileB.files[0]) { setStatus('رفع الملفين مطلوب'); return; }
  startWorker();
  setStatus('إعداد الإرسال إلى الـ Worker...');
  const abA = await fileToArrayBuffer(fileA.files[0]);
  const abB = await fileToArrayBuffer(fileB.files[0]);
  // نرسل بنقل الذاكرة (Transferable)
  worker.postMessage({type:'analyzePair', files:[abA, abB]}, [abA, abB]);
});

function fileToArrayBuffer(file){
  return new Promise((res, rej)=>{
    const r = new FileReader();
    r.onload = ()=> res(r.result);
    r.onerror = rej;
    r.readAsArrayBuffer(file);
  });
}

async function renderResult(payload){
  setStatus('تم الانتهاء');
  summary.innerText = `خطر التلاعب: ${Math.round(payload.score*100)}%`;
  // عرض تفاصيل
  details.innerHTML = `
    <div>ملخص: ${payload.summary}</div>
    <div>مربعات التغيير: ${payload.bboxes.length}</div>
  `;

  // عرض heatmap / صورة مرجعية
  const canvas = canvasOverlay;
  const ctx = canvas.getContext('2d');

  const imgBlob = payload.overlayImageBlob;
  const img = new Image();
  img.onload = ()=>{
    // اضبط حجم الكانفس بما يتناسب
    canvas.width = img.width; canvas.height = img.height;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(img,0,0);
    // ارسم مستطيلات
    ctx.lineWidth = 2; ctx.strokeStyle = 'red';
    payload.bboxes.forEach(bb=> ctx.strokeRect(bb.x, bb.y, bb.w, bb.h));
  };
  img.src = URL.createObjectURL(imgBlob);
}
