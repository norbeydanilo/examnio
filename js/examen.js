import { app } from './firebase-config.js';
import { escHtml as esc, normalizarTexto, renderCodigoConLineas, calcPuntaje } from './utils.js';
import { getFirestore, doc, collection, getDocs, getDoc, setDoc, updateDoc,
         arrayUnion, serverTimestamp, onSnapshot,
         enableIndexedDbPersistence } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const db = getFirestore(app);
enableIndexedDbPersistence(db).catch(()=>{});

// ── Modo prueba ───────────────────────────────────────────────
const MODO_PRUEBA = new URLSearchParams(window.location.search).get('modo') === 'prueba';
if (MODO_PRUEBA) {
  document.title = '⚙ Examen [MODO PRUEBA]';
  document.getElementById('test-bar').classList.add('visible');
  document.getElementById('status-bar').style.top = '28px';
}

// ── Estado ────────────────────────────────────────────────────
let S = {
  examenId:null, examenData:null, preguntas:[],
  estudiante:null, primario:null, secundario:null, respDocId:null,
  respuestas:{}, eventos:[], currentIdx:0, entregado:false,
  timerInterval:null, secondsLeft:0, eventAlertCount:0,
  _passHash:null,
};
// Devuelve el/los nombre(s) a mostrar en pantalla: ambos si es examen en pareja, uno si es individual
function nombresParaMostrar() {
  if (S.secundario && S.secundario.nombre) {
    return `${S.primario.nombre}  &  ${S.secundario.nombre}`;
  }
  return S.estudiante ? S.estudiante.nombre : '';
}
// Muestra en la pantalla de "Examen entregado" la cantidad de eventos sospechosos registrados
function mostrarResumenEventos(eventos) {
  const el = document.getElementById('finish-eventos');
  if (!el) return;
  const n = (eventos||[]).length;
  el.textContent = n>0
    ? `⚠ ${n} evento${n!==1?'s':''} sospechoso${n!==1?'s':''} registrado${n!==1?'s':''} durante el examen.`
    : '✓ Sin eventos sospechosos registrados.';
  el.style.color = n>0 ? 'var(--warning)' : 'var(--text2)';
}
let pendingNext = false; // para el modal de sin respuesta
let modalidadDetectada = 'individual'; // modalidad configurada por el profesor para el examen
let modoRegistro = 'parejas';          // elección del estudiante cuando el examen es de parejas: 'parejas' | 'individual'
let pendingIniciarUI = null; // callback diferido mientras se muestra la contraseña de pareja

// ── Generador de contraseña de sesión para parejas ─────────────
// Alfanumérica con símbolo, ej: H4QzN* — garantiza mayúscula, minúscula, dígito y símbolo.
function genPass(len=6) {
  const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin I/O para evitar confusiones
  const lower   = 'abcdefghijkmnpqrstuvwxyz'; // sin l/o
  const digits  = '23456789';                 // sin 0/1
  const symbols = '*+-?#@';
  const all = upper + lower + digits + symbols;
  const pick = set => set[Math.floor(Math.random()*set.length)];
  let chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < len) chars.push(pick(all));
  for (let i=chars.length-1; i>0; i--) { // barajar
    const j = Math.floor(Math.random()*(i+1));
    [chars[i],chars[j]] = [chars[j],chars[i]];
  }
  return chars.join('');
}

// ── El estudiante elige presentar en pareja o solo (si el examen es de parejas) ──
window.setModoRegistro = (modo) => {
  modoRegistro = modo;
  const btnPareja = document.getElementById('btn-modo-pareja');
  const btnIndiv  = document.getElementById('btn-modo-individual');
  const activo    = {border:'2px solid var(--accent2)',background:'rgba(124,92,191,.15)',color:'var(--accent2)'};
  const inactivo  = {border:'2px solid var(--border)',background:'var(--surface2)',color:'var(--text)'};
  const set = (el, styleObj) => { Object.assign(el.style, styleObj); };
  if (modo === 'parejas') { set(btnPareja, activo); set(btnIndiv, inactivo); }
  else { set(btnIndiv, activo); set(btnPareja, inactivo); }
  aplicarVisibilidadModalidad();
};

function aplicarVisibilidadModalidad() {
  const esPareja = modalidadDetectada === 'parejas' && modoRegistro === 'parejas';
  document.getElementById('pareja-fields').style.display        = esPareja ? 'block' : 'none';
  document.getElementById('field-pass-nuevo').style.display      = esPareja ? 'none'  : 'block';
  document.getElementById('field-pass-pareja-info').style.display = esPareja ? 'block' : 'none';
}

// ── Detectar modalidad del examen al escribir su código ────────
window.checkModalidadNuevo = async () => {
  const exCod = document.getElementById('n-examen').value.trim().toUpperCase();
  const modInfo   = document.getElementById('modalidad-info');
  const modoToggle = document.getElementById('modo-registro-toggle');
  if (!exCod) { modalidadDetectada = 'individual'; }
  else {
    try {
      const snap = await getDoc(doc(db,'examenes',exCod));
      modalidadDetectada = (snap.exists() && snap.data().modalidad === 'parejas') ? 'parejas' : 'individual';
    } catch(_) { modalidadDetectada = 'individual'; }
  }
  const esExamenPareja = modalidadDetectada === 'parejas';
  modInfo.style.display    = esExamenPareja ? 'block' : 'none';
  modoToggle.style.display = esExamenPareja ? 'block' : 'none';
  modoRegistro = 'parejas'; // por defecto, si el examen es de parejas se asume que presentan en pareja
  if (esExamenPareja) window.setModoRegistro('parejas');
  else aplicarVisibilidadModalidad();
};

const LS = () => `ex_${S.examenId}_${S.respDocId}`;

// ── Utilidades ────────────────────────────────────────────────
const shuffle = a => { for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a; };

async function hashStr(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ── Conexión ──────────────────────────────────────────────────
const updateConn = () => {
  const el = document.getElementById('conn-status');
  el.className = navigator.onLine ? 'online' : 'offline';
  el.innerHTML = navigator.onLine
    ? '<span class="status-dot"></span>Conectado'
    : '<span class="status-dot"></span>Sin conexión — guardado localmente';
};
window.addEventListener('online', updateConn);
window.addEventListener('offline', updateConn);
updateConn();

// ── Router hash ───────────────────────────────────────────────
function showPage(id) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

window.goTo = (ruta) => {
  window.location.hash = ruta;
};

function handleRoute() {
  const hash = window.location.hash.replace('#','') || 'landing';
  const map  = {
    'landing':   'page-landing',
    'nuevo':     'page-nuevo',
    'continuar': 'page-continuar',
  };
  if (map[hash]) showPage(map[hash]);
}
window.addEventListener('hashchange', handleRoute);
handleRoute();

// ── Toggle contraseña ─────────────────────────────────────────
window.togglePass = (inputId, btn) => {
  const inp = document.getElementById(inputId);
  inp.type  = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
};

// ── LOGIN NUEVO ───────────────────────────────────────────────
window.doLoginNuevo = async () => {
  const apellidos = document.getElementById('n-apellidos').value.trim();
  const nombres   = document.getElementById('n-nombres').value.trim();
  const nombre    = [apellidos, nombres].filter(Boolean).join(' ');
  const correo  = document.getElementById('n-correo').value.trim();
  const codigo  = document.getElementById('n-codigo').value.trim();
  const exCod   = document.getElementById('n-examen').value.trim().toUpperCase();
  const errEl   = document.getElementById('error-nuevo');
  const btn     = document.getElementById('btn-nuevo');
  const esPareja = modalidadDetectada === 'parejas' && modoRegistro === 'parejas';
  const pass    = esPareja ? genPass() : document.getElementById('n-pass').value;

  let nombre2='', correo2='', codigo2='';
  if (esPareja) {
    const apellidos2 = document.getElementById('n2-apellidos').value.trim();
    const nombres2   = document.getElementById('n2-nombres').value.trim();
    nombre2 = [apellidos2, nombres2].filter(Boolean).join(' ');
    correo2 = document.getElementById('n2-correo').value.trim();
    codigo2 = document.getElementById('n2-codigo').value.trim();
  }

  errEl.style.display = 'none';
  if (!exCod) {
    errEl.textContent='Ingresa el código del examen.'; errEl.style.display='block'; return;
  }
  if (!apellidos||!nombres||!correo||!codigo) {
    errEl.textContent='Completa todos los campos.'; errEl.style.display='block'; return;
  }
  if (esPareja && (!nombre2||!correo2||!codigo2)) {
    errEl.textContent='Completa los datos del integrante 2.'; errEl.style.display='block'; return;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(correo) || (esPareja && !emailRegex.test(correo2))) {
    errEl.textContent='Ingresa correos electrónicos válidos.'; errEl.style.display='block'; return;
  }
  if (esPareja && codigo2 === codigo) {
    errEl.textContent='Los códigos de los dos integrantes deben ser diferentes.'; errEl.style.display='block'; return;
  }
  if (!esPareja && pass.length < 4) {
    errEl.textContent='La contraseña debe tener al menos 4 caracteres.'; errEl.style.display='block'; return;
  }
  btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  try {
    await iniciarSesion({ nombre, correo, codigo, exCod, pass, esNuevo: true, esPareja, nombre2, correo2, codigo2 });
  } catch(e) {
    errEl.textContent = e.message; errEl.style.display='block';
    btn.disabled=false; btn.textContent='Iniciar examen';
  }
};


// ── Confirmar contraseña de pareja vista ────────────────────────
window.confirmarPasswordPareja = () => {
  document.getElementById('pareja-pass-overlay').style.display = 'none';
  if (typeof pendingIniciarUI === 'function') { pendingIniciarUI(); pendingIniciarUI = null; }
};

// ── LOGIN CONTINUAR ───────────────────────────────────────────
window.doLoginContinuar = async () => {
  const codigo  = document.getElementById('c-codigo').value.trim();
  const exCod   = document.getElementById('c-examen').value.trim().toUpperCase();
  const pass    = document.getElementById('c-pass').value;
  const errEl   = document.getElementById('error-continuar');
  const btn     = document.getElementById('btn-continuar');

  errEl.style.display = 'none';
  if (!codigo||!exCod||!pass) {
    errEl.textContent='Completa todos los campos.'; errEl.style.display='block'; return;
  }
  if (pass.length < 4) {
    errEl.textContent='La contraseña debe tener al menos 4 caracteres.';
    errEl.style.display='block'; return;
  }
  btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  try {
    await iniciarSesion({ codigo, exCod, pass, esNuevo: false });
  } catch(e) {
    errEl.textContent = e.message; errEl.style.display='block';
    btn.disabled=false; btn.textContent='Continuar';
  }
};

// ── LÓGICA COMÚN DE SESIÓN ────────────────────────────────────
async function iniciarSesion({ nombre, correo, codigo, exCod, pass, esNuevo, esPareja, nombre2, correo2, codigo2 }) {
  // 1. Verificar examen — si está inactivo pero hay retro activa, permitir ver retro
  const exSnap = await getDoc(doc(db,'examenes',exCod));
  if (!exSnap.exists()) throw new Error('Código de examen no válido.');
  const exData = exSnap.data();

  S.examenId   = exCod;
  S.examenData = exData;

  // Construir respDocId
  // Para continuar necesitamos buscar por código — el nombre lo sacamos de Firebase
  let respDocId;
  if (esNuevo) {
    if (!exData.activo && esNuevo) throw new Error('Este examen no está activo aún. Espera al profesor.');
    S.estudiante = { nombre, correo, codigo };
    S.primario   = { nombre, correo, codigo };
    S.secundario = esPareja ? { nombre: nombre2, correo: correo2, codigo: codigo2 } : null;
    respDocId    = `${codigo}-${nombre.replace(/\s+/g,'-').toLowerCase()}`;
  } else {
    // Para continuar: exData ya se obtuvo arriba, no hace falta volver a pedirlo
    if (!exData.activo && !exData.retroAlimentacionVisible) {
      throw new Error('La retroalimentación de este examen no está disponible aún. El profesor la habilitará cuando lo considere.');
    }
    // Intentar obtener respDocId desde localStorage primero
    const lsKeys = Object.keys(localStorage).filter(k => k.startsWith(`ex_${exCod}_${codigo}-`));
    if (lsKeys.length) {
      respDocId = lsKeys[0].replace(`ex_${exCod}_`, '');
    } else {
      // No está en localStorage — buscar en Firestore por código de estudiante
      // (en modo parejas, el código puede corresponder al integrante 1 o al integrante 2)
      const estudiantesSnap = await getDocs(collection(db, 'respuestas', exCod, 'estudiantes'));
      let encontrado = null;
      estudiantesSnap.forEach(d => {
        const dd = d.data();
        if (dd.codigo === codigo || dd.codigo2 === codigo) encontrado = d.id;
      });
      if (!encontrado) {
        throw new Error('No se encontró tu intento. Usa "Empezar examen" si es tu primera vez.');
      }
      respDocId = encontrado;
    }
  }

  S.respDocId = respDocId;
  const passHash = await hashStr(pass + respDocId);
  S._passHash    = passHash;

  // 2. Verificar en Firebase
  const ref      = doc(db,'respuestas',exCod,'estudiantes',respDocId);
  const existSnap = await getDoc(ref);

  if (existSnap.exists()) {
    const existing = existSnap.data();
    if (existing.passHash && existing.passHash !== passHash) {
      // Verificar si es contraseña temporal
      if (existing.tempPass && existing.tempPass === pass) {
        // Permitir con contraseña temporal — marcar como usada
        await updateDoc(ref, { tempPass: null });
      } else {
        throw new Error('Contraseña incorrecta.');
      }
    }
    if (!esNuevo) {
      // El registro (nombre/código/correo "principales") nunca cambia al continuar
      S.primario   = { nombre: existing.nombre, correo: existing.correo||'', codigo: existing.codigo };
      S.secundario = existing.codigo2 ? { nombre: existing.nombre2||'', correo: existing.correo2||'', codigo: existing.codigo2 } : null;
      if (!S.estudiante) {
        // Identificar cuál de los dos integrantes está consultando (modo parejas)
        if (existing.codigo2 && existing.codigo2 === codigo) {
          S.estudiante = { nombre: existing.nombre2, correo: existing.correo2||'', codigo: existing.codigo2 };
        } else {
          S.estudiante = { nombre: existing.nombre, correo: existing.correo||'', codigo: existing.codigo };
        }
      }
    }
    if (existing.entregado) {
      document.getElementById('finish-name').textContent = nombresParaMostrar();
      mostrarResumenEventos(existing.eventos||[]);
      showPage('page-finish');
      checkRetroDisponible();
      return;
    }
    S.respuestas = existing.respuestas || {};
    S.eventos    = existing.eventos    || [];
  } else if (!esNuevo) {
    throw new Error('No se encontró tu intento. Usa "Empezar examen" si es tu primera vez.');
  }

  // 3. Restaurar desde localStorage
  const saved = localStorage.getItem(LS());
  if (saved) {
    const p = JSON.parse(saved);
    if (p.entregado) {
      document.getElementById('finish-name').textContent = nombresParaMostrar();
      mostrarResumenEventos(p.eventos || S.eventos);
      showPage('page-finish'); checkRetroDisponible(); return;
    }
    if (Object.keys(p.respuestas||{}).length > Object.keys(S.respuestas).length) {
      S.respuestas = p.respuestas || {};
    }
    S.eventos    = p.eventos    || S.eventos;
    S.currentIdx = p.currentIdx || 0;
    S.preguntas  = p.preguntas  || [];
  }

  // 4. Aleatorizar preguntas (primera vez)
  if (!S.preguntas.length) {
    S.preguntas = shuffle([...exData.preguntas]).map(q => {
      const sq = {...q};
      if (q.opciones) sq.opciones = shuffle([...q.opciones]);
      if (q.items)    sq.items    = shuffle([...q.items]);
      return sq;
    });
  }

  const ordenPreguntas = S.preguntas.map(q => q.id);

  // 5. Crear/actualizar doc en Firebase
  const docData = {
    nombre: S.primario.nombre,
    correo: S.primario.correo||'',
    codigo: S.primario.codigo,
    passHash,
    inicio: serverTimestamp(),
    entregado: false,
    respuestas: S.respuestas,
    eventos: S.eventos,
    calificacion: null,
    ordenPreguntas,
  };
  if (esNuevo && esPareja) {
    docData.esPareja = true;
    docData.nombre2  = nombre2;
    docData.correo2  = correo2;
    docData.codigo2  = codigo2;
  }
  await setDoc(ref, docData, { merge: true });

  // 6. Iniciar UI (se difiere si hay que mostrar la contraseña de pareja primero)
  const iniciarUI = () => {
    if (!MODO_PRUEBA) { setupEvents(); startHeartbeat(); }
    renderHeader();
    startTimer();
    renderQuestion(S.currentIdx);

    document.getElementById('student-name-top').textContent   = nombresParaMostrar();
    document.getElementById('student-name-label').textContent = nombresParaMostrar();
    if (S.eventos.length > 0) updateAlertWidget();
    showPage('page-exam');
    window.location.hash = 'exam';
  };

  if (esNuevo && esPareja) {
    document.getElementById('pareja-pass-display').textContent = pass;
    document.getElementById('pareja-pass-overlay').style.display = 'flex';
    pendingIniciarUI = iniciarUI;
  } else {
    iniciarUI();
  }
}

// ── TIMER ─────────────────────────────────────────────────────
function startTimer() {
  const ex = S.examenData;
  if (MODO_PRUEBA || !ex.tiempoMinutos || ex.tiempoMinutos <= 0) return;
  const saved = JSON.parse(localStorage.getItem(LS()) || '{}');
  let startTs = saved.startTs || Date.now();
  if (!saved.startTs) {
    const cur = JSON.parse(localStorage.getItem(LS()) || '{}');
    cur.startTs = Date.now(); startTs = cur.startTs;
    localStorage.setItem(LS(), JSON.stringify(cur));
  }
  const totalMs = ex.tiempoMinutos * 60 * 1000;
  S.secondsLeft = Math.max(0, Math.floor((totalMs - (Date.now()-startTs))/1000));
  const timerEl = document.getElementById('timer-display');
  timerEl.style.display = 'block';
  const tick = () => {
    if (S.entregado) return;
    const m=Math.floor(S.secondsLeft/60), s=S.secondsLeft%60;
    timerEl.textContent = String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
    timerEl.className = S.secondsLeft<=60?'danger':S.secondsLeft<=300?'warning':'';
    if (S.secondsLeft<=0) {
      clearInterval(S.timerInterval);
      document.getElementById('timeup-overlay').classList.add('visible');
      setTimeout(()=>finishExam(true), 10000);
      return;
    }
    S.secondsLeft--;
  };
  tick();
  S.timerInterval = setInterval(tick, 1000);
}

// ── HEADER ────────────────────────────────────────────────────
function renderHeader() {
  const ex = S.examenData;
  document.getElementById('exam-title').textContent    = ex.titulo||'Examen';
  document.getElementById('exam-subtitle').textContent = ex.subtitulo||'';
}

// ── STEPPER / PROGRESO ────────────────────────────────────────
function renderStepper(idx) {
  document.getElementById('stepper').innerHTML = S.preguntas.map((_,i)=>
    `<div class="step-dot ${i<idx?'done':i===idx?'current':''}" title="Pregunta ${i+1}"></div>`
  ).join('');
}
function updateProgress(idx) {
  const n=S.preguntas.length;
  document.getElementById('prog-bar-fill').style.width = n?Math.round(((idx+1)/n)*100)+'%':'0%';
  document.getElementById('prog-text').textContent = `${idx+1} / ${n}`;
  const btn=document.getElementById('btn-next');
  if(idx===n-1){btn.textContent='Entregar ✓';btn.classList.add('finish');}
  else{btn.textContent='Siguiente →';btn.classList.remove('finish');}
}

// ── RENDER PREGUNTA ───────────────────────────────────────────
function renderQuestion(idx) {
  const q=S.preguntas[idx], answered=S.respuestas[idx]!==undefined;
  renderStepper(idx); updateProgress(idx);
  const typeLabel={unica:'Selección única',multiple:'Selección múltiple',
    verdaderoFalso:'Verdadero / Falso',completar:'Completar',
    abierto:'Pregunta abierta',emparejar:'Emparejar',ordenar:'Ordenar'}[q.tipo]||q.tipo;

  let codigoHtml = '';
  if (q.codigo) {
    codigoHtml = renderCodigoConLineas(q.codigo, q.lenguaje||'Java');
  }

  document.getElementById('question-area').innerHTML = `
    <div class="question-card">
      <div class="q-header">
        <div class="q-num">${idx+1}</div>
        <span class="q-type-tag">${typeLabel}</span>
        <span class="q-pts">${q.puntaje} pt${q.puntaje!==1?'s':''}</span>
      </div>
      <div class="q-body">
        ${q.tipo !== 'completar' ? `<div class="q-enunciado">${q.enunciado}</div>` : ''}
        ${q.imagen?`<img src="${q.imagen}" style="max-width:100%;border-radius:8px;border:1px solid var(--border);margin-bottom:14px" alt="imagen">`:''}
        ${q.tipo !== 'completar' ? codigoHtml : ''}
        <div id="answer-ui">${renderAnswerUI(q,idx)}</div>
        ${q.tipo === 'completar' ? codigoHtml : ''}
        ${answered?`<div class="locked-note">🔒 Respuesta guardada — no se puede modificar</div>`:''}
      </div>
    </div>`;



  if (answered) lockUI(q, idx);

}

// ── RENDER UI POR TIPO ────────────────────────────────────────
function stripLetra(s){ return s.replace(/^[A-Da-d][).\s]+/,'').trim(); }
function renderTexto(s){ return stripLetra(s).replace(/\n/g,'<br>'); }

function renderAnswerUI(q, idx) {
  switch(q.tipo) {
    case 'unica':
      return '<ul class="options-list">'+q.opciones.map((op,oi)=>
        `<li class="option-item" id="opt-${idx}-${oi}" onclick="selOpt(${idx},${oi},false)">
          <div class="option-marker">${String.fromCharCode(65+oi)}</div>
          <span class="option-text">${renderTexto(op)}</span></li>`).join('')+'</ul>';
    case 'multiple':
      return '<ul class="options-list">'+q.opciones.map((op,oi)=>
        `<li class="option-item option-multiple" id="opt-${idx}-${oi}" onclick="selOpt(${idx},${oi},true)">
          <div class="option-marker">✓</div>
          <span class="option-text">${renderTexto(op)}</span></li>`).join('')+'</ul>';
    case 'verdaderoFalso':
      return `<div class="tf-group">
        <button class="tf-btn" id="tf-${idx}-true" onclick="selTF(${idx},true)">✔ Verdadero</button>
        <button class="tf-btn" id="tf-${idx}-false" onclick="selTF(${idx},false)">✘ Falso</button></div>`;
    case 'completar': {
      let i=0;
      const txt=q.enunciado.replace(/___/g,()=>`<input class="blank-input" id="blank-${idx}-${i++}" placeholder="...">`);
      return `<div class="completar-text">${txt}</div>`;
    }
    case 'abierto':
      return `<textarea class="open-textarea" id="open-${idx}" placeholder="Escribe tu respuesta aquí..."></textarea>`;
    case 'emparejar': {
      const der=shuffle(q.pares.map(p=>p.derecha));
      return `<div class="match-grid">
        <div>${q.pares.map((p,pi)=>`<div class="match-left-item"><span class="match-label">${String.fromCharCode(65+pi)}</span>${p.izquierda}</div>`).join('')}</div>
        <div>${q.pares.map((_,pi)=>`<div class="match-right-item">
          <div class="match-right-label">Para ${String.fromCharCode(65+pi)}</div>
          <select class="match-select" id="match-${idx}-${pi}">
            <option value="">— selecciona —</option>
            ${der.map(d=>`<option value="${d}">${d}</option>`).join('')}
          </select></div>`).join('')}</div></div>`;
    }
    case 'ordenar':
      return `<ul class="sort-list" id="sort-${idx}">${q.items.map((item,ii)=>
        `<li class="sort-item" draggable="true" data-pos="${ii}"
          ondragstart="dStart(event)" ondragover="dOver(event)" ondrop="dDrop(event,${idx})">
          <span class="drag-handle">⠿</span>${item}</li>`).join('')}</ul>`;
    default: return '<p style="color:var(--text2)">Tipo no soportado.</p>';
  }
}

function lockUI(q,idx){
  restoreAnswer(q,idx,S.respuestas[idx]);
  document.querySelectorAll('#answer-ui input,#answer-ui select,#answer-ui textarea,#answer-ui button,#answer-ui li')
    .forEach(el=>{el.style.pointerEvents='none';el.style.opacity='.7';if(el.tagName==='LI')el.style.cursor='default';});
}

// ── INTERACCIONES ─────────────────────────────────────────────
window.selOpt=(qIdx,opIdx,multi)=>{
  const items=document.querySelectorAll('#answer-ui .option-item');
  if(multi){items[opIdx].classList.toggle('selected');}
  else{items.forEach(it=>it.classList.remove('selected'));items[opIdx].classList.add('selected');}
};
window.selTF=(qIdx,val)=>{
  document.getElementById(`tf-${qIdx}-true`).className ='tf-btn'+(val?' selected-true':'');
  document.getElementById(`tf-${qIdx}-false`).className='tf-btn'+(!val?' selected-false':'');
};
let dragPos=null;
window.dStart=e=>{dragPos=parseInt(e.currentTarget.dataset.pos);};
window.dOver =e=>{e.preventDefault();document.querySelectorAll('.sort-item').forEach(i=>i.classList.remove('drag-over'));e.currentTarget.classList.add('drag-over');};
window.dDrop =(e,qIdx)=>{
  e.preventDefault();
  const target=parseInt(e.currentTarget.dataset.pos);
  const list=document.getElementById(`sort-${qIdx}`);
  const items=[...list.querySelectorAll('.sort-item')];
  if(dragPos!==null&&dragPos!==target){
    if(dragPos<target)list.insertBefore(items[dragPos],items[target].nextSibling);
    else list.insertBefore(items[dragPos],items[target]);
  }
  [...list.querySelectorAll('.sort-item')].forEach((it,i)=>{it.dataset.pos=i;it.classList.remove('drag-over');});
};

// ── RESTAURAR RESPUESTA ───────────────────────────────────────
function restoreAnswer(q,idx,val){
  const items=[...document.querySelectorAll('#answer-ui .option-item')];
  switch(q.tipo){
    case 'unica':{const i=q.opciones.indexOf(val);if(i>=0&&items[i])items[i].classList.add('selected');break;}
    case 'multiple':{(val||[]).forEach(v=>{const i=q.opciones.indexOf(v);if(i>=0&&items[i])items[i].classList.add('selected');});break;}
    case 'verdaderoFalso':window.selTF(idx,val);break;
    case 'completar':(val||[]).forEach((v,i)=>{const el=document.getElementById(`blank-${idx}-${i}`);if(el)el.value=v;});break;
    case 'abierto':{const el=document.getElementById(`open-${idx}`);if(el)el.value=val||'';break;}
    case 'emparejar':Object.entries(val||{}).forEach(([pi,v])=>{const s=document.getElementById(`match-${idx}-${pi}`);if(s)s.value=v;});break;
  }
}

// ── RECOGER RESPUESTA ─────────────────────────────────────────
function collectAnswer(q,idx){
  switch(q.tipo){
    case 'unica':{const i=[...document.querySelectorAll('#answer-ui .option-item')].findIndex(it=>it.classList.contains('selected'));return i>=0?q.opciones[i]:null;}
    case 'multiple':{const sel=[...document.querySelectorAll('#answer-ui .option-item')].reduce((a,it,i)=>{if(it.classList.contains('selected'))a.push(q.opciones[i]);return a;},[]);return sel.length?sel:null;}
    case 'verdaderoFalso':{const t=document.getElementById(`tf-${idx}-true`);const f=document.getElementById(`tf-${idx}-false`);if(t&&t.classList.contains('selected-true'))return true;if(f&&f.classList.contains('selected-false'))return false;return null;}
    case 'completar':{const v=[];let i=0;q.enunciado.replace(/___/g,()=>{const el=document.getElementById(`blank-${idx}-${i++}`);v.push(el?el.value.trim():'');});return v.every(x=>x==='')?null:v;}
    case 'abierto':{const el=document.getElementById(`open-${idx}`);return el&&el.value.trim()?el.value.trim():null;}
    case 'emparejar':{const r={};let any=false;q.pares.forEach((_,pi)=>{const s=document.getElementById(`match-${idx}-${pi}`);if(s&&s.value){r[pi]=s.value;any=true;}});return any?r:null;}
    case 'ordenar':{const list=document.getElementById(`sort-${idx}`);if(!list)return null;return[...list.querySelectorAll('.sort-item')].map(it=>it.textContent.trim().replace('⠿','').trim());}
    default:return null;
  }
}

// ── SIGUIENTE ─────────────────────────────────────────────────
window.handleNext = async () => {
  const idx=S.currentIdx, q=S.preguntas[idx], isLast=idx===S.preguntas.length-1;
  if (S.respuestas[idx]!==undefined) {
    if (isLast) { openModal('modal-entregar'); return; }
    S.currentIdx++; saveLocal(); renderQuestion(S.currentIdx); return;
  }
  const val=collectAnswer(q,idx);
  if (val===null) {
    if (isLast) {
      // En última pregunta sin responder: confirmar entrega directamente
      openModal('modal-entregar'); return;
    }
    // Mostrar modal de sin respuesta
    pendingNext = true;
    openModal('modal-sin-respuesta');
    return;
  }
  S.respuestas[idx]=val;
  await persistAnswer(idx,val);
  if (isLast) { openModal('modal-entregar'); return; }
  S.currentIdx++; saveLocal(); renderQuestion(S.currentIdx);
};

window.confirmarSinRespuesta = async () => {
  closeModal('modal-sin-respuesta');
  const idx=S.currentIdx, isLast=idx===S.preguntas.length-1;
  S.respuestas[idx]='';
  await persistAnswer(idx,'');
  if (isLast) { openModal('modal-entregar'); return; }
  S.currentIdx++; saveLocal(); renderQuestion(S.currentIdx);
};

// ── MODAL ─────────────────────────────────────────────────────
window.openModal  = id => document.getElementById(id).classList.add('visible');
window.closeModal = id => document.getElementById(id).classList.remove('visible');

// ── PERSISTIR / LOCAL ─────────────────────────────────────────
async function persistAnswer(idx,val){
  saveLocal();
  try{await updateDoc(doc(db,'respuestas',S.examenId,'estudiantes',S.respDocId),{[`respuestas.${idx}`]:val});}catch(_){}
}
function saveLocal(){
  const ex=JSON.parse(localStorage.getItem(LS())||'{}');
  localStorage.setItem(LS(),JSON.stringify({...ex,respuestas:S.respuestas,eventos:S.eventos,currentIdx:S.currentIdx,preguntas:S.preguntas,entregado:S.entregado,passHash:S._passHash}));
}

// ── ENTREGA ───────────────────────────────────────────────────
window.finishExam = async (forced=false) => {
  closeModal('modal-entregar');
  document.getElementById('timeup-overlay').classList.remove('visible');
  if(S.entregado)return;
  S.entregado=true;
  if(S.timerInterval)clearInterval(S.timerInterval);
  saveLocal();

  // Calcular puntaje automático
  const preguntas=S.examenData.preguntas||[];
  const esc2=S.examenData.escala||{notaMin:0,notaMax:5,notaApro:3};
  const ptsTotal=preguntas.reduce((s,q)=>s+q.puntaje,0);
  let ptsAuto=0;
  S.preguntas.forEach((q,i)=>{
    if(q.autoCalificable)ptsAuto+=calcPuntaje(S.respuestas[i],q);
  });
  const notaCalc=ptsTotal?parseFloat((esc2.notaMin+(ptsAuto/ptsTotal)*(esc2.notaMax-esc2.notaMin)).toFixed(2)):esc2.notaMin;

  try{
    await updateDoc(doc(db,'respuestas',S.examenId,'estudiantes',S.respDocId),{
      entregado:true,fin:serverTimestamp(),entregadoForzado:forced,
      puntajeTotal:parseFloat(ptsAuto.toFixed(2)),
    });
  }catch(_){}

  // Mostrar pantalla de finalización con puntos y nota
  document.getElementById('finish-name').textContent=nombresParaMostrar();
  mostrarResumenEventos(S.eventos);
  document.getElementById('finish-pts').textContent=ptsAuto.toFixed(2);
  document.getElementById('finish-pts-max').textContent=ptsTotal.toFixed(2);
  document.getElementById('finish-nota').textContent=notaCalc.toFixed(2);
  document.getElementById('score-display').style.display='flex';
  showPage('page-finish');
  checkRetroDisponible();
};

// ── CÁLCULO LOCAL (al entregar) ───────────────────────────────


// ── RETROALIMENTACIÓN ─────────────────────────────────────────
function checkRetroDisponible(){
  const btnWrap   = document.getElementById('retro-btn-wrap');
  const pendingMsg= document.getElementById('retro-pending-msg');
  let retroActiva=false, tieneCalifAuto=false, tieneNota=false;

  const actualizar=()=>{
    if(tieneCalifAuto||retroActiva){
      if(btnWrap)    btnWrap.style.display='block';
      if(pendingMsg) pendingMsg.style.display='none';
      const notaMsg=document.getElementById('retro-btn-nota-msg');
      if(notaMsg)    notaMsg.style.display=tieneNota?'none':'block';
    }else{
      if(btnWrap)    btnWrap.style.display='none';
      if(pendingMsg) pendingMsg.style.display='block';
    }
  };

  onSnapshot(doc(db,'examenes',S.examenId),(snap)=>{
    retroActiva=snap.exists()&&snap.data().retroAlimentacionVisible;
    actualizar();
  });

  onSnapshot(doc(db,'respuestas',S.examenId,'estudiantes',S.respDocId),(snap)=>{
    if(!snap.exists()) return;
    const data=snap.data();
    tieneCalifAuto = data.puntajeTotal!==undefined && data.puntajeTotal!==null;
    tieneNota      = data.calificacion!==undefined && data.calificacion!==null;
    actualizar();

    // ── Actualizar page-finish en tiempo real ──────────────
    const esc       = S.examenData?.escala || {notaMin:0,notaMax:50,notaApro:30};
    const preguntas = S.examenData?.preguntas || [];
    const ptsTotal  = preguntas.reduce((s,q)=>s+(q.puntaje||0),0);
    const scoreDisp = document.getElementById('score-display');

    // Puntos obtenidos
    const ptsEl = document.getElementById('finish-pts');
    if(ptsEl && data.puntajeTotal!==undefined)
      ptsEl.textContent = parseFloat(data.puntajeTotal).toFixed(2);

    // Puntos máximos — se setea aquí también para cuando vienen por Continuar
    const ptsmaxEl = document.getElementById('finish-pts-max');
    if(ptsmaxEl && ptsTotal > 0)
      ptsmaxEl.textContent = ptsTotal.toFixed(2);

    // Mostrar score-display si tiene datos
    if(tieneCalifAuto && scoreDisp) scoreDisp.style.display='flex';

    // Nota final
    const notaEl = document.getElementById('finish-nota');
    if(tieneNota && notaEl){
      notaEl.textContent = parseFloat(data.calificacion).toFixed(2);
      notaEl.style.color = data.calificacion>=esc.notaApro
        ? 'var(--success)' : 'var(--danger)';
      if(scoreDisp) scoreDisp.style.display='flex';

      // Badge aprueba/reprueba
      let apBadge=document.getElementById('finish-aprueba-badge');
      if(!apBadge){
        apBadge=document.createElement('div');
        apBadge.id='finish-aprueba-badge';
        apBadge.style.cssText='margin-top:8px;font-size:14px;font-weight:700;padding:6px 18px;border-radius:20px;display:inline-block;';
        const notaBoxEl=document.querySelector('.score-box.nota');
        if(notaBoxEl) notaBoxEl.appendChild(apBadge);
      }
      const aprueba=data.calificacion>=esc.notaApro;
      apBadge.textContent      = aprueba?'✓ Aprobado':'✗ Reprobado';
      apBadge.style.background = aprueba?'rgba(46,204,113,.15)':'rgba(231,76,60,.15)';
      apBadge.style.color      = aprueba?'var(--success)':'var(--danger)';
    } else if(notaEl && !tieneNota){
      notaEl.textContent='—';
      notaEl.style.color='var(--text2)';
    }

    // ── Mensaje según estado de calificación ───────────────
    const msgEl = document.getElementById('finish-estado-msg');
    if(msgEl){
      if(tieneNota){
        msgEl.textContent = '✓ Tu examen ha sido revisado y calificado por el profesor.';
        msgEl.style.color = 'var(--success)';
      } else if(tieneCalifAuto){
        msgEl.textContent = 'La nota final será publicada por el profesor una vez revise las preguntas manuales.';
        msgEl.style.color = 'var(--text2)';
      } else {
        msgEl.textContent = 'Tu examen está en revisión.';
        msgEl.style.color = 'var(--text2)';
      }
    }
  });
}

window.verRetroalimentacion = async () => {
  try{
    const [respSnap,exSnap]=await Promise.all([
      getDoc(doc(db,'respuestas',S.examenId,'estudiantes',S.respDocId)),
      getDoc(doc(db,'examenes',S.examenId))
    ]);
    if(!respSnap.exists()||!exSnap.exists())return;
    const examen=exSnap.data(), estudiante=respSnap.data();
    const preguntas=examen.preguntas||[], respuestas=estudiante.respuestas||{};
    const esc2=examen.escala||{notaMin:0,notaMax:5,notaApro:3};
    const ptsTotal=preguntas.reduce((s,q)=>s+q.puntaje,0);
    document.getElementById('retro-title').textContent=examen.titulo||'Retroalimentación';
    let retroSubt = S.estudiante.nombre;
    if (estudiante.esPareja) {
      const esEst2 = estudiante.codigo2 && estudiante.codigo2 === S.estudiante.codigo;
      const companero = esEst2 ? estudiante.nombre : estudiante.nombre2;
      const companeroCod = esEst2 ? estudiante.codigo : estudiante.codigo2;
      if (companero) retroSubt += '  ·  en pareja con: ' + companero + (companeroCod ? ' (' + companeroCod + ')' : '');
    }
    document.getElementById('retro-subtitle').textContent = retroSubt;

    // Nota
    const nota=estudiante.calificacion, ptsObt=estudiante.puntajeTotal;
    const notaEl=document.getElementById('retro-nota');
    const apEl=document.getElementById('retro-aprueba');
    const apBox=document.getElementById('retro-aprueba-box');
    const ptsEl=document.getElementById('retro-pts-total');
    if(nota!==null&&nota!==undefined){
      notaEl.textContent=nota.toFixed(1);
      const ap=nota>=esc2.notaApro;
      apEl.textContent=ap?'✓ Aprobado':'✗ Reprobado';
      apEl.style.background=ap?'rgba(46,204,113,.15)':'rgba(231,76,60,.15)';
      apEl.style.color=ap?'var(--success)':'var(--danger)';
      apBox.style.display='block';
    }else{
      notaEl.textContent='—';notaEl.style.color='var(--text2)';
    }
    ptsEl.textContent=(ptsObt!==undefined?ptsObt.toFixed(2):'—')+' / '+ptsTotal;

    // Mostrar fórmula explicada
    const formulaBox = document.getElementById('retro-formula-box');
    const formulaText = document.getElementById('retro-formula-text');
    if (formulaBox && formulaText && ptsObt !== undefined) {
      const notaMin = esc2.notaMin, notaMax = esc2.notaMax, notaApro = esc2.notaApro;
      const ptsObtenidos = parseFloat(ptsObt.toFixed(2));
      const notaCalc = nota !== null && nota !== undefined ? nota : parseFloat((notaMin + (ptsObtenidos/ptsTotal)*(notaMax-notaMin)).toFixed(2));
      formulaBox.style.display = 'block';
      formulaText.innerHTML =
        `<strong style="color:var(--text)">Fórmula:</strong> notaFinal = notaMin + (puntosObtenidos / puntosTotal) × (notaMax − notaMin)<br>` +
        `<strong style="color:var(--text)">Tu resultado:</strong> ` +
        `<span style="color:var(--accent)">${notaCalc.toFixed(2)}</span> = ` +
        `${notaMin} + (${ptsObtenidos} / ${ptsTotal}) × (${notaMax} − ${notaMin})<br>` +
        `<strong style="color:var(--text)">Escala:</strong> ` +
        `${notaMin} (mínima) · ${notaApro} (aprobatoria) · ${notaMax} (máxima)`;
    }

    // Mapear respuestas con orden del estudiante
    const orden=estudiante.ordenPreguntas||[];
    const porId={};preguntas.forEach(q=>{porId[q.id]=q;});
    const mapa=orden.length
      ?orden.map((id,i)=>({pregunta:porId[id]||null,respuesta:respuestas[i]})).filter(x=>x.pregunta)
      :preguntas.map((q,i)=>({pregunta:q,respuesta:respuestas[i]}));

    document.getElementById('retro-preguntas').innerHTML=mapa.map(({pregunta:q,respuesta:resp},qi)=>{
      const pts=calcPuntaje(resp,q), maxPts=q.puntaje, esManual=!q.autoCalificable;
      const cls=esManual?'manual':pts===maxPts?'correct':pts>0?'partial':'incorrect';
      const tag=esManual?'✏ Revisión manual':pts===maxPts?'✓ Correcto':pts>0?'~ Parcial':'✗ Incorrecto';
      const typeLabel={unica:'Única',multiple:'Múltiple',verdaderoFalso:'V/F',completar:'Completar',abierto:'Abierta',emparejar:'Emparejar',ordenar:'Ordenar'}[q.tipo]||q.tipo;

      let codigoHtml='';
      if(q.codigo){ codigoHtml = renderCodigoConLineas(q.codigo, q.lenguaje||'Java'); }

      return `<div class="retro-card ${cls}">
        <div class="retro-q-header">
          <div class="retro-num">${qi+1}</div>
          <span style="font-size:12px;color:var(--text2)">${typeLabel}</span>
          <span class="retro-result-tag">${tag}</span>
          <span class="retro-pts">${esManual?(((estudiante.calificacionManual||{})[q.id]!==undefined)?((estudiante.calificacionManual||{})[q.id]).toFixed(2)+'✓':'?'):pts.toFixed(2)} / ${maxPts} pts</span>
        </div>
        <div class="retro-body">
          <div class="retro-enunciado">${q.enunciado}</div>
          ${q.imagen?`<img src="${q.imagen}" style="max-width:100%;border-radius:8px;border:1px solid var(--border);margin-bottom:10px;margin-top:6px" alt="imagen">`:''}
          ${codigoHtml}
          <div class="retro-row">
            <div class="retro-box your">
              <div class="retro-box-label">Tu respuesta</div>
              <div class="retro-box-value">${fmtRespRetro(resp,q)||'<em style="color:var(--text2)">Sin respuesta</em>'}</div>
            </div>
            ${esManual
              ?(()=>{
                const manPts=(estudiante.calificacionManual||{})[q.id];
                if(manPts!==undefined)
                  return `<div class="retro-box pending"><div class="retro-box-label">Calificación manual</div><div class="retro-box-value"><span style="font-size:18px;font-weight:700;color:var(--accent2)">${manPts.toFixed(2)}</span> / ${q.puntaje} pts</div></div>`;
                return '<div class="retro-box pending"><div class="retro-box-label">Calificación</div><div class="retro-box-value" style="color:var(--accent2)">Pendiente de revisión por el profesor</div></div>';
              })()
              :`<div class="retro-box answer"><div class="retro-box-label">Respuesta correcta</div><div class="retro-box-value">${fmtCorrectaRetro(q)}</div></div>`}
          </div>
        </div>
        ${q.retroalimentacion ? `
        <div style="margin-top:10px;background:rgba(79,142,247,.07);border:1px solid rgba(79,142,247,.15);border-radius:8px;padding:10px 14px;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--accent);margin-bottom:4px;font-weight:600">💡 Retroalimentación</div>
          <div style="font-size:13px;color:var(--text);line-height:1.6">${q.retroalimentacion}</div>
        </div>` : ''}
        ${esManual && ((estudiante.calificacionManual||{})[q.id+'_fb']||'') ? `
        <div style="margin-top:8px;background:rgba(124,92,191,.07);border:1px solid rgba(124,92,191,.2);border-radius:8px;padding:10px 14px;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--accent2);margin-bottom:4px;font-weight:600">✏ Comentario del profesor</div>
          <div style="font-size:13px;color:var(--text);line-height:1.6">${(estudiante.calificacionManual||{})[q.id+'_fb']}</div>
        </div>` : ''}
      </div>`;
    }).join('');

    showPage('page-retro');
    window.location.hash='retro';

    // Mostrar botón PDF si el profesor lo habilitó
    const btnPdf = document.getElementById('btn-pdf-retro');
    if(btnPdf) btnPdf.style.display = examen.pdfHabilitado ? 'block' : 'none';
  }catch(e){alert('Error: '+e.message);console.error(e);}
};

function fmtRespRetro(resp,q){
  if(resp===undefined||resp===null||resp==='')return'';
  if(typeof resp==='boolean')return resp?'Verdadero':'Falso';
  if(resp===0||resp===1)return resp===1?'Verdadero':'Falso';
  if(typeof resp==='string')return resp;
  if(Array.isArray(resp))return resp.join(' / ');
  if(typeof resp==='object')return Object.entries(resp).map(([k,v])=>(q.pares&&q.pares[parseInt(k)]?q.pares[parseInt(k)].izquierda:k)+' → '+v).join('<br>');
  return String(resp);
}
function fmtCorrectaRetro(q){
  switch(q.tipo){
    case 'unica':return (q.correcta||'—').replace(/\n/g,'<br>');
    case 'multiple':return (q.correctas||[]).join('<br>');
    case 'verdaderoFalso':return q.correcta?'Verdadero':'Falso';
    case 'emparejar':return (q.pares||[]).map(p=>p.izquierda+' → '+p.derecha).join('<br>');
    case 'ordenar':return (q.correctos||[]).join(' → ');
    case 'completar':return (q.espacios||[]).join(' / ');
    default:return'—';
  }
}

// ── HEARTBEAT ─────────────────────────────────────────────────
function startHeartbeat(){
  const ref=doc(db,'respuestas',S.examenId,'estudiantes',S.respDocId);
  const beat=async()=>{if(S.entregado)return;try{await updateDoc(ref,{lastSeen:serverTimestamp()});}catch(_){}};
  beat();setInterval(beat,30000);
  document.addEventListener('visibilitychange',async()=>{
    if(document.hidden){try{await updateDoc(ref,{desconexiones:arrayUnion({hora:new Date().toLocaleTimeString('es-CO'),ts:Date.now(),tipo:'oculto'})});}catch(_){}}
    else beat();
  });
  window.addEventListener('offline',async()=>{try{await updateDoc(ref,{desconexiones:arrayUnion({hora:new Date().toLocaleTimeString('es-CO'),ts:Date.now(),tipo:'sin internet'})});}catch(_){};});
}

// ── EVENTOS SOSPECHOSOS ───────────────────────────────────────
const EVENTOS_IGNORADOS=2;
function setupEvents(){
  document.addEventListener('visibilitychange',()=>{if(document.hidden)logEvent('Cambio de pestaña');});
  window.addEventListener('blur',()=>{if(!document.hidden)logEvent('Ventana perdió el foco');});
  document.addEventListener('contextmenu',e=>{e.preventDefault();logEvent('Clic derecho');});
  document.addEventListener('copy',()=>logEvent('Copiar texto (Ctrl+C)'));
  document.addEventListener('cut',()=>logEvent('Cortar texto (Ctrl+X)'));
  document.addEventListener('paste',()=>logEvent('Pegar texto (Ctrl+V)'));
  document.addEventListener('keydown',e=>{
    if(e.key==='F12'||(e.ctrlKey&&e.shiftKey&&['I','J','C'].includes(e.key))){e.preventDefault();logEvent('Intento DevTools');}
    if(e.ctrlKey&&e.key==='u'){e.preventDefault();logEvent('Ver código fuente');}
    if(e.ctrlKey&&e.key==='p'){e.preventDefault();logEvent('Imprimir');}
    if(e.key==='PrintScreen')logEvent('Captura de pantalla');
  });
  window.addEventListener('beforeprint',()=>logEvent('Imprimir página'));
  // Nota: se eliminó el evento de selección de texto (era molesto para leer)
}

async function logEvent(tipo){
  if(S.entregado)return;
  S.eventAlertCount++;
  if(S.eventAlertCount<=EVENTOS_IGNORADOS)return;
  const ev={tipo,pregunta:S.currentIdx+1,hora:new Date().toLocaleTimeString('es-CO'),ts:Date.now()};
  S.eventos.push(ev);saveLocal();
  const b=document.getElementById('warning-banner');
  b.style.display='block';setTimeout(()=>{b.style.display='none';},3000);
  document.getElementById('events-count').textContent=S.eventos.length+' evento'+(S.eventos.length!==1?'s':'');
  updateAlertWidget();showEventAlert(tipo);
  try{await updateDoc(doc(db,'respuestas',S.examenId,'estudiantes',S.respDocId),{eventos:arrayUnion(ev)});}catch(_){}
}

function updateAlertWidget(){
  if(MODO_PRUEBA)return;
  const n=S.eventos.length, widget=document.getElementById('alert-widget');
  if(!n){widget.classList.remove('visible');return;}
  widget.classList.add('visible');
  document.getElementById('widget-count').textContent=n;
  const lbl=document.getElementById('widget-label');
  if(n===1)lbl.innerHTML='evento registrado.<br>⚠ Siguiente: <strong style="color:var(--danger)">examen anulado</strong>';
  else if(n===2)lbl.innerHTML='eventos registrados.<br>🚨 <strong style="color:var(--danger)">Alerta máxima.</strong>';
  else lbl.innerHTML='eventos registrados.<br>🚨 <strong style="color:var(--danger)">El profesor revisará tu examen.</strong>';
  document.getElementById('widget-bar-fill').style.width=Math.min((n/3)*100,100)+'%';
}

function showEventAlert(tipo){
  document.getElementById('event-alert-msg').innerHTML=`Detectado: <strong>${tipo}</strong><br><br>Este evento fue registrado. <strong>En una próxima ocurrencia tu examen será anulado y la nota quedará en cero.</strong>`;
  document.getElementById('event-alert').classList.add('visible');
}
window.closeEventAlert=()=>document.getElementById('event-alert').classList.remove('visible');



// Normalizar texto para comparación: minúsculas, sin tildes ni caracteres especiales


// ── DESCARGAR PDF RETROALIMENTACIÓN ──────────────────────────
window.descargarPDFRetro = async () => {
  if (!window.jspdf) { alert('Error cargando jsPDF'); return; }
  const { jsPDF } = window.jspdf;

  try {
    const [respSnap, exSnap] = await Promise.all([
      getDoc(doc(db, 'respuestas', S.examenId, 'estudiantes', S.respDocId)),
      getDoc(doc(db, 'examenes', S.examenId))
    ]);
    if (!respSnap.exists() || !exSnap.exists()) return;

    const examen     = exSnap.data();
    const estudiante = respSnap.data();

    // Personalizar identidad: si el examen fue en pareja, el PDF muestra
    // los datos de quien está consultando (S.estudiante), no un dato genérico.
    let companeroNombre = null;
    let companeroCodigo = null;
    if (estudiante.esPareja) {
      const esEst2 = estudiante.codigo2 && estudiante.codigo2 === S.estudiante.codigo;
      companeroNombre = esEst2 ? estudiante.nombre  : estudiante.nombre2;
      companeroCodigo = esEst2 ? estudiante.codigo  : estudiante.codigo2;
      estudiante.nombre = S.estudiante.nombre;
      estudiante.codigo = S.estudiante.codigo;
      estudiante.correo = S.estudiante.correo || '';
    }

    const preguntas  = examen.preguntas || [];
    const respuestas = estudiante.respuestas || {};
    const esc        = examen.escala || { notaMin:0, notaMax:50, notaApro:30 };
    const ptsTotal   = preguntas.reduce((s,q) => s + q.puntaje, 0);
    const ptsObt     = estudiante.puntajeTotal ?? 0;
    const nota       = estudiante.calificacion;

    const orden = estudiante.ordenPreguntas || [];
    const porId = {};
    preguntas.forEach(q => { porId[q.id] = q; });
    const mapa = orden.length
      ? orden.map((id,i) => ({ pregunta:porId[id]||null, respuesta:respuestas[i] })).filter(x=>x.pregunta)
      : preguntas.map((q,i) => ({ pregunta:q, respuesta:respuestas[i] }));

    const fmtTs = ts => {
      if(!ts) return '-';
      try { const d=ts.toDate?ts.toDate():new Date(ts.seconds*1000); return d.toLocaleString('es-CO'); }
      catch(_){ return '-'; }
    };

    // Limpiar texto: quitar HTML, emojis y caracteres problemáticos para jsPDF
    const clean = s => String(s||'')
      .replace(/<[^>]+>/g,'')
      .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"')
      .replace(/[^ -~À-ÿÀ-ɏ]/g, '')  // solo latin extendido
      .trim();

    const fmtR = (resp,q) => {
      if(resp===undefined||resp===null||resp==='') return 'Sin respuesta';
      if(typeof resp==='boolean') return resp?'Verdadero':'Falso';
      if(resp===0||resp===1) return resp===1?'Verdadero':'Falso';
      if(Array.isArray(resp)) return resp.map(clean).join(', ');
      if(typeof resp==='object') return Object.entries(resp).map(([k,v])=>{
        const p=q.pares&&q.pares[parseInt(k)];
        return clean(p?p.izquierda:k)+' -> '+clean(v);
      }).join('  /  ');
      return clean(String(resp));
    };
    const fmtC = q => {
      switch(q.tipo){
        case 'unica':        return clean(q.correcta||'-');
        case 'multiple':     return (q.correctas||[]).map(clean).join('  /  ');
        case 'verdaderoFalso': return q.correcta?'Verdadero':'Falso';
        case 'completar':    return (q.espacios||[]).map(clean).join(' / ');
        case 'emparejar':    return (q.pares||[]).map(p=>clean(p.izquierda)+' -> '+clean(p.derecha)).join('  /  ');
        case 'ordenar':      return (q.correctos||[]).map(clean).join(' -> ');
        default:             return '-';
      }
    };

    const pdf = new jsPDF({ orientation:'p', unit:'mm', format:'a4' });
    const W=210, M=15, CW=W-M*2;
    let y = M;

    // Paleta
    const BG      = [15, 17, 23];
    const SURFACE = [26, 29, 39];
    const SURF2   = [34, 38, 58];
    const ACCENT  = [79, 142, 247];
    const ACCENT2 = [124, 92, 191];
    const SUCCESS = [46, 204, 113];
    const WARN    = [243, 156, 18];
    const DANGER  = [231, 76, 60];
    const TEXT    = [232, 234, 240];
    const TEXT2   = [139, 144, 168];
    const BORDER  = [46, 51, 80];

    const fillBg = () => { pdf.setFillColor(...BG); pdf.rect(0,0,W,297,'F'); };
    const chk = (n=12) => { if(y+n>283){ pdf.addPage(); y=M; fillBg(); } };

    const sf = (size, bold=false, color=TEXT) => {
      pdf.setFontSize(size);
      pdf.setFont('helvetica', bold?'bold':'normal');
      pdf.setTextColor(...color);
    };

    const block = (yy, h, color=SURFACE, radius=1.5) => {
      pdf.setFillColor(...color);
      pdf.roundedRect(M, yy, CW, h, radius, radius, 'F');
    };

    const accentBar = (yy, h, color=ACCENT) => {
      pdf.setFillColor(...color);
      pdf.rect(M, yy, 2.5, h, 'F');
    };

    const writeTxt = (t, x, yy, maxW, size, bold=false, color=TEXT, align='left') => {
      sf(size, bold, color);
      const lines = pdf.splitTextToSize(clean(t), maxW);
      pdf.text(lines, x, yy, {align});
      return lines.length;
    };

    const writeBlock = (t, x, maxW, size, bold=false, color=TEXT) => {
      sf(size, bold, color);
      const lines = pdf.splitTextToSize(clean(t), maxW);
      chk(lines.length * 5.2 + 2);
      pdf.text(lines, x, y);
      y += lines.length * 5.2;
      return lines.length;
    };

    // ── Fondo ──
    fillBg();

    // ── HEADER ──────────────────────────────────────────────
    pdf.setFillColor(...[10,12,20]);
    pdf.rect(0, 0, W, 40, 'F');
    pdf.setFillColor(...ACCENT);
    pdf.rect(0, 0, 4, 40, 'F');

    sf(18, true, ACCENT);
    pdf.text('Examnio', M+4, 14);

    sf(8, false, TEXT2);
    pdf.text('Integridad academica en el examen digital', M+4, 21);

    sf(10, true, TEXT);
    const titleLines = pdf.splitTextToSize(clean(examen.titulo||S.examenId), CW-20);
    pdf.text(titleLines, M+4, 29);

    sf(7, false, TEXT2);
    pdf.text(new Date().toLocaleDateString('es-CO'), W-M, 12, {align:'right'});

    y = 48;

    // ── ESTUDIANTE ───────────────────────────────────────────
    const estBoxH = companeroNombre ? 38 : 32;
    chk(estBoxH+2);
    block(y, estBoxH, SURF2);
    accentBar(y, estBoxH, ACCENT);

    sf(6.5, true, ACCENT);    pdf.text('ESTUDIANTE', M+6, y+7);
    sf(11,  true, TEXT);      pdf.text(clean(estudiante.nombre||'-'), M+6, y+14);
    sf(8,   false, TEXT2);    pdf.text('Codigo: '+clean(estudiante.codigo||'-'), M+6, y+21);
    pdf.text('Correo: '+clean(estudiante.correo||'-'), M+6, y+26);
    if (companeroNombre) {
      sf(7.5, false, ACCENT2);
      pdf.text('Examen presentado en pareja con: '+clean(companeroNombre)+(companeroCodigo?'  (Codigo: '+clean(companeroCodigo)+')':''), M+6, y+32);
    }
    y += estBoxH+6;

    // ── METADATA ─────────────────────────────────────────────
    chk(12);
    sf(7.5, false, TEXT2);
    pdf.text('Inicio: '+fmtTs(estudiante.inicio)+'   Fin: '+fmtTs(estudiante.fin), M, y);
    y += 5;
    pdf.text('Entrega: '+(estudiante.entregadoForzado?'Forzada (tiempo)':'Voluntaria')+'   Eventos sospechosos: '+(estudiante.eventos||[]).length, M, y);
    y += 5;

    // Listar eventos sospechosos si hay
    const evts = estudiante.eventos || [];
    if(evts.length > 0){
      chk(evts.length * 5 + 8);
      pdf.setFillColor(40, 25, 15); pdf.roundedRect(M, y, CW, evts.length*4.8+8, 1.5, 1.5, 'F');
      pdf.setFillColor(...WARN); pdf.rect(M, y, 2.5, evts.length*4.8+8, 'F');
      sf(6, true, WARN); pdf.text('EVENTOS SOSPECHOSOS', M+5, y+5.5);
      evts.forEach((ev, ei) => {
        sf(7, false, [230, 200, 160]);
        const evTxt = clean('P'+ev.pregunta+'  '+ev.hora+'  '+ev.tipo);
        pdf.text(evTxt, M+5, y+10+ei*4.8);
      });
      y += evts.length*4.8+12;
    } else {
      y += 4;
    }

    // ── RESULTADO ────────────────────────────────────────────
    chk(34);
    block(y, 30, SURFACE);
    pdf.setFillColor(...BORDER);
    pdf.roundedRect(M, y, CW, 30, 1.5, 1.5, 'S');

    const notaColor = nota!==null&&nota!==undefined ? (nota>=esc.notaApro?SUCCESS:DANGER) : TEXT2;
    const notaStr   = nota!==null&&nota!==undefined ? nota.toFixed(2) : 'Pendiente';

    sf(6.5, true, TEXT2);
    pdf.text('PUNTOS OBTENIDOS', M+6,        y+8);
    pdf.text('PUNTOS TOTALES',   M+6+CW/4,   y+8);
    pdf.text('NOTA FINAL',       M+6+CW/2,   y+8);
    pdf.text('FORMULA',          M+6+CW*3/4, y+8);

    sf(13, true, ACCENT);    pdf.text(ptsObt.toFixed(2),   M+6,        y+20);
    sf(13, true, TEXT);      pdf.text(ptsTotal.toFixed(2), M+6+CW/4,   y+20);
    sf(13, true, notaColor); pdf.text(notaStr,              M+6+CW/2,   y+20);
    sf(7,  false, TEXT2);
    const formula = esc.notaMin+' + ('+ptsObt.toFixed(2)+'/'+ptsTotal+') x ('+esc.notaMax+'-'+esc.notaMin+')';
    const fLines  = pdf.splitTextToSize(formula, CW/4-8);
    pdf.text(fLines, M+6+CW*3/4, y+16);
    y += 36;

    // ── TÍTULO SECCIÓN ───────────────────────────────────────
    chk(10);
    sf(8, true, TEXT2);
    pdf.text('DETALLE POR PREGUNTA', M, y);
    pdf.setDrawColor(...BORDER);
    pdf.setLineWidth(0.3);
    pdf.line(M, y+2.5, W-M, y+2.5);
    y += 9;

    // ── PREGUNTAS ────────────────────────────────────────────
    mapa.forEach(({pregunta:q, respuesta:resp}, qi) => {
      const pts   = q.autoCalificable ? calcPuntaje(resp, q) : null;
      const esMan = !q.autoCalificable;
      const ok    = pts!==null && pts>=q.puntaje;
      const par   = pts!==null && pts>0 && pts<q.puntaje;
      const sColor = esMan?ACCENT2 : ok?SUCCESS : par?WARN : DANGER;
      const sLabel = esMan?'Manual' : ok?'Correcto' : par?'Parcial' : 'Incorrecto';
      const pLabel = esMan?'? / '+q.puntaje+' pts' : pts.toFixed(2)+' / '+q.puntaje+' pts';
      const tipoL  = {unica:'Unica',multiple:'Multiple',verdaderoFalso:'V/F',
        completar:'Completar',abierto:'Abierta',emparejar:'Emparejar',ordenar:'Ordenar'}[q.tipo]||q.tipo;

      // Calcular altura total del bloque para evitar cortes
      sf(8.5, false, TEXT);
      const enLines = pdf.splitTextToSize(clean(q.enunciado), CW-8);
      const tuLines = pdf.splitTextToSize(fmtR(resp,q), (CW-3)/2-6);
      const coLines = pdf.splitTextToSize(esMan?'Pendiente de revision':fmtC(q), (CW-3)/2-6);
      const retLines = q.retroalimentacion ? pdf.splitTextToSize(clean(q.retroalimentacion), CW-10) : [];
      const totalH = 12 + enLines.length*5.2+6 + Math.max(tuLines.length,coLines.length)*5.2+14 + (retLines.length?(retLines.length*5.2+12):0) + 8;
      chk(Math.min(totalH, 60));

      // Header
      block(y, 10, SURF2);
      pdf.setFillColor(...sColor);
      pdf.rect(M, y, 2.5, 10, 'F');
      sf(8, true, TEXT);
      pdf.text(qi+1+'.  '+tipoL, M+6, y+6.5);
      sf(7.5, true, sColor);
      pdf.text(sLabel, M+CW/2, y+6.5);
      sf(8, false, TEXT2);
      pdf.text(pLabel, W-M-2, y+6.5, {align:'right'});
      y += 12;

      // Enunciado
      const enH = enLines.length*5.2+8;
      chk(enH+2);
      block(y, enH, SURFACE);
      sf(8.5, false, TEXT);
      pdf.text(enLines, M+4, y+6);
      y += enH+3;

      // Respuestas
      const hW = (CW-3)/2;
      const bH = Math.max(tuLines.length, coLines.length)*5.2+12;
      chk(bH+4);

      // Box izquierdo: tu respuesta
      pdf.setFillColor(...SURFACE); pdf.roundedRect(M, y, hW, bH, 1.5, 1.5, 'F');
      pdf.setFillColor(...ACCENT); pdf.rect(M, y, 2.5, bH, 'F');
      sf(6, true, TEXT2); pdf.text('TU RESPUESTA', M+5, y+5.5);
      sf(8.5, false, TEXT); pdf.text(tuLines, M+5, y+10.5);

      // Box derecho: respuesta correcta
      pdf.setFillColor(...SURF2); pdf.roundedRect(M+hW+3, y, hW, bH, 1.5, 1.5, 'F');
      pdf.setFillColor(...sColor); pdf.rect(M+hW+3, y, 2.5, bH, 'F');
      sf(6, true, TEXT2); pdf.text(esMan?'CALIFICACION':'RESPUESTA CORRECTA', M+hW+7, y+5.5);
      sf(8.5, false, esMan?ACCENT2:TEXT); pdf.text(coLines, M+hW+7, y+10.5);
      y += bH+3;

      // Retroalimentacion
      if(q.retroalimentacion && retLines.length){
        const retH = retLines.length*5.2+10;
        chk(retH+2);
        pdf.setFillColor(18,22,40); pdf.roundedRect(M, y, CW, retH, 1.5, 1.5, 'F');
        pdf.setFillColor(...ACCENT); pdf.rect(M, y, 2.5, retH, 'F');
        sf(6, true, ACCENT);  pdf.text('Retroalimentacion', M+5, y+5.5);
        sf(8, false, [190,210,245]); pdf.text(retLines, M+5, y+10.5);
        y += retH+3;
      }

      // Separador
      pdf.setDrawColor(...BORDER);
      pdf.setLineWidth(0.2);
      pdf.line(M, y, W-M, y);
      y += 6;
    });

    // ── FIRMA ────────────────────────────────────────────────
    chk(20);
    y += 4;
    pdf.setDrawColor(...BORDER);
    pdf.setLineWidth(0.2);
    pdf.line(M, y, W-M, y);
    y += 9;
    sf(8.5, true, TEXT2);
    pdf.text('Norbey Danilo Muñoz', W-M, y, {align:'right'});
    sf(7, false, TEXT2);
    pdf.text('Examnio v0.1', W-M, y+5, {align:'right'});

    // ── PIE ──────────────────────────────────────────────────
    const pages = pdf.internal.getNumberOfPages();
    for(let i=1; i<=pages; i++){
      pdf.setPage(i);
      pdf.setFillColor(10,12,20); pdf.rect(0,289,W,8,'F');
      sf(7, false, TEXT2);
      pdf.text('Examnio  |  '+clean(examen.titulo||'')+'  |  '+clean(estudiante.nombre||''), M, 294);
      pdf.text(i+' / '+pages, W-M, 294, {align:'right'});
    }

    const slug = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g,'')
      .replace(/[^a-zA-Z0-9]/g,'_').replace(/_+/g,'_').replace(/^_|_$/g,'');
    pdf.save(slug(estudiante.codigo)+'_'+slug(estudiante.nombre)+'_'+slug(examen.titulo||S.examenId)+'.pdf');

  } catch(e) {
    alert('Error generando PDF: ' + e.message);
    console.error(e);
  }
};

