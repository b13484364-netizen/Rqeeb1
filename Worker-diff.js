// worker-diff.js
// ملاحظة: يفضل استضافة opencv.js محليًا ثم استدعاؤه عبر importScripts('./opencv.js') لثبات أكبر.

self.importScripts('https://docs.opencv.org/4.x/opencv.js');
self.importScripts('https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/tesseract.min.js');

let cvReady = false;
self.Module = self.Module || {};
self.Module.onRuntimeInitialized = () => { cvReady = true; postMessage({type:'progress', text:'OpenCV جاهز'}); };

onmessage = async (e) => {
  try{
    if (e.data.type === 'analyzePair'){
      postMessage({type:'progress', text:'بدء المعالجة في الـ Worker...'});
      const [abA, abB] = e.data.files;

      // decode إلى ImageBitmap
      const imgA = await createImageBitmap(new Blob([abA]));
      const imgB = await createImageBitmap(new Blob([abB]));
      postMessage({type:'progress', text:'صُورتان مفكوكتان'});

      // نحدد أقصى بعد للمعالجة
      const MAX_DIM = 1024;
      const canvasA = new OffscreenCanvas(imgA.width, imgA.height);
      const ctxA = canvasA.getContext('2d');
      ctxA.drawImage(imgA,0,0);

      const canvasB = new OffscreenCanvas(imgB.width, imgB.height);
      const ctxB = canvasB.getContext('2d');
      ctxB.drawImage(imgB,0,0);

      // إعادة قياس إن احتاج
      function fitResize(canvas){
        const w = canvas.width, h = canvas.height;
        const scale = Math.min(1, MAX_DIM / Math.max(w,h));
        if (scale === 1) return canvas; // لا تغيير
        const nc = new OffscreenCanvas(Math.round(w*scale), Math.round(h*scale));
        nc.getContext('2d').drawImage(canvas,0,0, nc.width, nc.height);
        return nc;
      }

      const rA = fitResize(canvasA);
      const rB = fitResize(canvasB);

      // تأكد من نفس الأبعاد: إذا اختلفنا، سنقوم بعمل warp بسيط عبر مقاييس
      const w = Math.max(rA.width, rB.width);
      const h = Math.max(rA.height, rB.height);
      const ra = new OffscreenCanvas(w,h);
      ra.getContext('2d').drawImage(rA,0,0);
      const rb = new OffscreenCanvas(w,h);
      rb.getContext('2d').drawImage(rB,0,0);

      // اقرأ إلى mats
      await waitForCv();
      const matA = cv.imread(ra);
      const matB = cv.imread(rb);

      postMessage({type:'progress', text:'بدأت عملية OpenCV'});

      // preprocessing: تحويل للرمادي، gaussian blur
      let grayA = new cv.Mat(); let grayB = new cv.Mat();
      cv.cvtColor(matA, grayA, cv.COLOR_RGBA2GRAY);
      cv.cvtColor(matB, grayB, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(grayA, grayA, new cv.Size(3,3), 0);
      cv.GaussianBlur(grayB, grayB, new cv.Size(3,3), 0);

      // حساب absdiff
      let diff = new cv.Mat();
      cv.absdiff(grayA, grayB, diff);

      // تعزيز الفروقات
      cv.threshold(diff, diff, 25, 255, cv.THRESH_BINARY);
      // تنقية: morphology
      let M = cv.Mat.ones(5,5, cv.CV_8U);
      cv.morphologyEx(diff, diff, cv.MORPH_CLOSE, M);
      cv.morphologyEx(diff, diff, cv.MORPH_OPEN, M);

      // العثور على contours لاستخراج bboxes
      let contours = new cv.MatVector();
      let hierarchy = new cv.Mat();
      cv.findContours(diff, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      const bboxes = [];
      for (let i=0;i<contours.size();i++){
        const cnt = contours.get(i);
        const rect = cv.boundingRect(cnt);
        // تجاهل البقع الصغيرة جدًا
        if (rect.width * rect.height < 100) continue;
        bboxes.push({x: rect.x, y: rect.y, w: rect.width, h: rect.height});
        cnt.delete();
      }

      // حساب score تقريبي: نسبة بكسلات الفروقات
      const nonZero = cv.countNonZero(diff);
      const total = diff.rows * diff.cols;
      let score = Math.min(1, nonZero / total * 5); // نوسع المؤثر ليعطي نطاق محسّن

      postMessage({type:'progress', text:'تم استخراج المناطق المحتملة'});

      // OCR (نصّي) — نركز على كل bbox ونقارن النتائج
      const tesseractWorker = Tesseract.createWorker({logger: m=>{ /* optional */ }});
      await tesseractWorker.load();
      await tesseractWorker.loadLanguage('ara+eng');
      await tesseractWorker.initialize('ara+eng');

      const bboxTexts = [];
      for (const bb of bboxes){
        // استخراج صورة المربع من rb
        const oc = new OffscreenCanvas(bb.w, bb.h);
        oc.getContext('2d').drawImage(rb, bb.x, bb.y, bb.w, bb.h, 0,0,bb.w,bb.h);
        const blob = await oc.convertToBlob({type:'image/png'});
        const { data: { text } } = await tesseractWorker.recognize(blob);
        bboxTexts.push({bb, text: text.trim()});
      }

      await tesseractWorker.terminate();

      // مزيج نتائج: إذا وُجد نص كبير مختلف في bboxes فزيد النِسْبَة
      let textChangeFactor = 0;
      for (const bt of bboxTexts){ if (bt.text.length>8) textChangeFactor += 0.2; }
      score = Math.min(1, score + textChangeFactor);

      // تجهيز overlay image (heatmap-like): نُعيد رسم الصورة B مع تلوين البقع
      const outCanvas = new OffscreenCanvas(w,h);
      const outCtx = outCanvas.getContext('2d');
      // ارسم الصورة B الأصلية
      outCtx.drawImage(rb,0,0);
      outCtx.globalAlpha = 0.35;
      outCtx.fillStyle = 'red';
      for (const bb of bboxes) outCtx.fillRect(bb.x, bb.y, bb.w, bb.h);
      outCtx.globalAlpha = 1.0;

      // export overlay
      const overlayBlob = await outCanvas.convertToBlob({type:'image/png'});

      // نظف الموارد
      matA.delete(); matB.delete(); grayA.delete(); grayB.delete(); diff.delete(); M.delete(); contours.delete(); hierarchy.delete();

      const payload = {
        overlayImageBlob: overlayBlob,
        bboxes,
        score,
        summary: `عدد المناطق المكتشفة: ${bboxes.length}`
      };

      postMessage({type:'result', payload});
    }
  } catch(err){
    postMessage({type:'error', text: String(err)});
  }
};

function waitForCv(){
  return new Promise((res)=>{
    if (cvReady) return res();
    const iid = setInterval(()=>{ if (cvReady){ clearInterval(iid); res(); }}, 100);
  });
}
