// ...existing code...
const videoElement = document.getElementById('video');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const continueBtn = document.getElementById('continueBtn');

const blinkCountEl = document.getElementById('blinkCount');
const microCountEl = document.getElementById('microCount');


// opcionales en HTML: sliders para ajustar preprocesado y un hint element
const brightnessRange = document.getElementById('brightnessRange'); // opcional
const contrastRange = document.getElementById('contrastRange'); // opcional
const saturationRange = document.getElementById('saturationRange'); // opcional
const lightHintEl = document.getElementById('lightHint'); // opcional (overlay texto)

let camera = null;
let running = false;

let conteo_parpadeos = 0;
let conteo_microsuenos = 0;
let parpadeo = false;
let inicio = 0;
let final = 0;

// buffer de aperturas (valor between 0..1) para suavizar con tfjs
const bufferSize = 15;
const aperturaBuffer = [];
const minBufferFill = 3;

// kernel para moving average (se usa con tfjs si está disponible)
let kernel = null;
if (typeof tf !== 'undefined') {
  kernel = tf.tensor1d(new Array(bufferSize).fill(1 / bufferSize), 'float32');
}


function actualizarUI() {
  blinkCountEl.textContent = conteo_parpadeos;
  microCountEl.textContent = conteo_microsuenos;
}

// calcula distancia entre dos landmarks (coord normalizadas) en pixeles relativos
function distanciaPx(p1, p2, w, h) {
  const dx = (p1.x - p2.x) * w;
  const dy = (p1.y - p2.y) * h;
  return Math.hypot(dx, dy);
}

const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});
faceMesh.setOptions({
  maxNumFaces: 1,
  refineLandmarks: true,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7
});

// PREPROCESADO: canvas intermedio con filtros para mejorar iluminación
const preCanvas = document.createElement('canvas');
const preCtx = preCanvas.getContext('2d');
preCanvas.width = 640;
preCanvas.height = 480;

// parámetros por defecto (se pueden ajustar vía sliders si existen)
let pre_brightness = 110; // % (100 = sin cambio)
let pre_contrast = 120;   // %
let pre_saturation = 100; // %
let pre_gamma = 1.0;      // no usado por defecto

// si existen sliders en HTML, sincronizarlos
function initSliders() {
  if (brightnessRange) {
    brightnessRange.value = pre_brightness;
    brightnessRange.addEventListener('input', (e) => pre_brightness = Number(e.target.value));
  }
  if (contrastRange) {
    contrastRange.value = pre_contrast;
    contrastRange.addEventListener('input', (e) => pre_contrast = Number(e.target.value));
  }
  if (saturationRange) {
    saturationRange.value = pre_saturation;
    saturationRange.addEventListener('input', (e) => pre_saturation = Number(e.target.value));
  }
}
initSliders();

function showLightHint(on) {
  if (lightHintEl) {
    lightHintEl.style.display = on ? 'block' : 'none';
    return;
  }
  if (on) console.warn('Iluminación baja: coloca más luz frontal.');
}

// promedio de luminancia (muestreo)
function averageLuminanceFromCanvas(ctx, w, h, step = 12) {
  try {
    const img = ctx.getImageData(0, 0, w, h).data;
    let sum = 0, count = 0;
    for (let i = 0; i < img.length; i += 4 * step) {
      sum += 0.2126 * img[i] + 0.7152 * img[i+1] + 0.0722 * img[i+2];
      count++;
    }
    return sum / Math.max(1, count);
  } catch (e) {
    return 255;
  }
}

faceMesh.onResults((results) => {
  if (!running) return;
  const w = preCanvas.width;
  const h = preCanvas.height;

  if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
    const lm = results.multiFaceLandmarks[0];

    // puntos del algoritmo original
    const L1 = lm[145], L2 = lm[159];
    const R1 = lm[374], R2 = lm[386];

    // referencia: ancho de cara entre 33 y 263
    const ref = distanciaPx(lm[33], lm[263], w, h) || 1;
    const aperturaIzq = distanciaPx(L1, L2, w, h) / ref; // normalizado
    const aperturaDer = distanciaPx(R1, R2, w, h) / ref; // normalizado
    const aperturaProm = (aperturaIzq + aperturaDer) / 2;

    // actualizar buffer
    aperturaBuffer.push(aperturaProm);
    if (aperturaBuffer.length > bufferSize) aperturaBuffer.shift();

    // calcular apertura suavizada
    let aperturaSuav = aperturaProm;
    if (kernel && aperturaBuffer.length >= minBufferFill) {
      tf.tidy(() => {
        const padded = (new Array(bufferSize - aperturaBuffer.length).fill(0)).concat(aperturaBuffer);
        const arr = tf.tensor1d(padded, 'float32');
        const reshaped = arr.reshape([1, bufferSize, 1]);
        const k = kernel.reshape([bufferSize, 1, 1]);
        const conv = tf.conv1d(reshaped, k, 1, 'valid'); // [1,1,1]
        aperturaSuav = conv.reshape([1]).arraySync()[0];
      });
    } else if (!kernel && aperturaBuffer.length > 0) {
      // fallback: media simple
      aperturaSuav = aperturaBuffer.reduce((a,b) => a+b, 0)/aperturaBuffer.length;
    }

    // umbral relativo: si apertura pequeña -> ojo cerrado
    const threshold = 0.03;

    if (aperturaSuav <= threshold && !parpadeo) {
      conteo_parpadeos += 1;
      parpadeo = true;
      inicio = performance.now() / 1000.0;
      actualizarUI();
    } else if (aperturaSuav > threshold && parpadeo) {
      parpadeo = false;
      final = performance.now() / 1000.0;
      const tiempo = Math.round((final - inicio) * 100) / 100;
      if (tiempo >= 3) {
        conteo_microsuenos += 1;
        
        actualizarUI();
      }
      inicio = 0;
      final = 0;
    }
  }
});

// Cámara usando Camera Utils de MediaPipe con preprocesado
function startCamera() {
  if (camera) return;
  camera = new Camera(videoElement, {
    onFrame: async () => {
      // dibujar video en canvas con filtros CSS
      preCtx.filter = `brightness(${pre_brightness}%) contrast(${pre_contrast}%) saturate(${pre_saturation}%)`;
      preCtx.drawImage(videoElement, 0, 0, preCanvas.width, preCanvas.height);

      // comprobar iluminación promedio y avisar si está muy baja
      const avg = averageLuminanceFromCanvas(preCtx, preCanvas.width, preCanvas.height, 12);
      showLightHint(avg < 40);

      // enviar canvas preprocesado a FaceMesh
      await faceMesh.send({image: preCanvas});
    },
    width: preCanvas.width,
    height: preCanvas.height
  });
  awaitStartCamera();
}

async function awaitStartCamera() {
  try {
    await camera.start();
    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    // establecer ruta absoluta coherente con el backend (templates)
    if (continueBtn) {
      continueBtn.style.display = 'inline-block';
      // si el href está vacío o relativo, forzar ruta a /actividades
      try {
        const currentHref = continueBtn.getAttribute('href') || '';
        if (!currentHref.startsWith('/')) {
          continueBtn.setAttribute('href', '/actividades');
        }
      } catch (e) {
        continueBtn.setAttribute('href', '/actividades');
      }
    }
  } catch (e) {
    console.error('Error al iniciar cámara:', e);
    alert('No se pudo iniciar la cámara: ' + (e.message || e));
  }
}

function stopCamera() {
  if (!camera) return;
  camera.stop();
  camera = null;
  running = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener('click', async () => {
  try {
    await navigator.mediaDevices.getUserMedia({video: true});
    startCamera();
  } catch (e) {
    alert('No se pudo acceder a la cámara: ' + (e.message || e));
  }
});

stopBtn.addEventListener('click', () => {
  stopCamera();
});

// actualizar ruta absoluta al pulsar (fallback si alguien modifica el href)
continueBtn.addEventListener('click', (e) => {
  // permitir comportamiento normal si es un enlace absoluto
  const href = continueBtn.getAttribute('href') || '';
  if (!href.startsWith('/')) {
    e.preventDefault();
    window.location.href = '/actividades';
  }
});

// inicial UI
actualizarUI();
