// Funciones compartidas entre examen.html (js/examen.js) y profesor.html
// (js/profesor.js). Antes estaban duplicadas —byte a byte— en ambos archivos.

export const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

export function normalizarTexto(s) {
  return String(s||'')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // quitar tildes y diacríticos
    .replace(/[^a-z0-9\s]/g, '')       // quitar caracteres especiales
    .trim()
    .replace(/\s+/g, ' ');             // espacios múltiples → uno solo
}

export function renderCodigoConLineas(codigo, lenguaje) {
  const lang = (lenguaje||'java').toLowerCase();
  const prismLang = {'java':'java','python':'python','javascript':'javascript',
    'js':'javascript','sql':'sql','cpp':'cpp','csharp':'csharp'}[lang]||lang;

  // Desescapar por si el código vino con entidades HTML del JSON
  const codigoLimpio = codigo
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"');

  // Resaltar con Prism (colores)
  let highlighted;
  if (window.Prism && window.Prism.languages[prismLang]) {
    highlighted = window.Prism.highlight(codigoLimpio, window.Prism.languages[prismLang], prismLang);
  } else {
    highlighted = codigoLimpio.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Números de línea manuales — alineación garantizada
  const lineas = highlighted.split('\n');
  if (lineas.length > 0 && lineas[lineas.length-1].trim() === '') lineas.pop();

  const filas = lineas.map((linea, i) => {
    const vacia = linea.trim() === '';
    return '<div class="code-row' + (vacia ? ' code-row-empty' : '') + '">' +
      '<span class="ln">' + (i+1) + '</span>' +
      '<span class="lc">' + (linea||'') + '</span>' +
      '</div>';
  }).join('');

  return '<div class="code-wrap">' +
    '<div class="code-header">' +
      '<span class="code-dot" style="background:#ff5f57"></span>' +
      '<span class="code-dot" style="background:#febc2e"></span>' +
      '<span class="code-dot" style="background:#28c840"></span>' +
      '<span class="code-lang-label">' + (lenguaje||'Java') + '</span>' +
    '</div>' +
    '<pre><code>' + filas + '</code></pre>' +
  '</div>';
}

// Puntaje obtenido por una respuesta autocalificable. Única fuente de verdad:
// antes existía como calcPuntajeLocal() en examen.html y calcPregunta() en
// profesor.html, con la misma lógica pero duplicada (riesgo de que divergieran).
export function calcPuntaje(resp,q){
  if(resp===undefined||resp===null||resp==='')return 0;
  switch(q.tipo){
    case 'unica':{
      // Normalizar: \n y " / " se consideran equivalentes
      const norm = s => String(s).replace(/\n/g,' / ').replace(/\s*\/\s*/g,' / ').trim();
      if(typeof resp==='string') return norm(resp)===norm(q.correcta)?q.puntaje:0;
      if(typeof resp==='number') return q.opciones&&norm(q.opciones[resp])===norm(q.correcta)?q.puntaje:0;
      return 0;
    }
    case 'multiple': {
      if(!Array.isArray(resp))return 0;
      const correctas=q.correctas||[];
      const restar=q.restar!==false;
      const n_corr=correctas.length||1;
      const ptsPorOpcion=q.puntaje/n_corr; // cada opción vale puntaje/n_correctas (estándar Moodle)
      let pts=0;
      resp.forEach(r=>{
        if(correctas.includes(r)) pts+=ptsPorOpcion;
        else if(restar) pts-=ptsPorOpcion;
      });
      return Math.max(0,parseFloat(pts.toFixed(4)));
    }
    case 'verdaderoFalso':{ let v=resp; if(v===0)v=false; if(v===1)v=true; return v===q.correcta?q.puntaje:0; }
    case 'emparejar':{ let ok=0;(q.pares||[]).forEach((p,pi)=>{if(resp[pi]===p.derecha||resp[String(pi)]===p.derecha)ok++;});return parseFloat(((ok/(q.pares||[]).length)*q.puntaje).toFixed(2)); }
    case 'ordenar':{ if(!Array.isArray(resp))return 0; let ok=0;(q.correctos||[]).forEach((v,i)=>{if(resp[i]===v)ok++;});return parseFloat(((ok/(q.correctos||[]).length)*q.puntaje).toFixed(2)); }
    case 'completar':{
      // Auto-calificable con normalización: minúsculas, sin tildes ni especiales
      if(!Array.isArray(resp))return 0;
      const espacios=q.espacios||[];
      if(!espacios.length)return 0;
      const norm=s=>String(s||'')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
        .replace(/[^a-z0-9,.\-\s]/g,'')  // conservar comas, puntos decimales y guiones medios
        .replace(/\s*,\s*/g,',')              // normalizar espacios alrededor de comas
        .replace(/\s*-\s*/g,'-')              // normalizar espacios alrededor de guiones
        .trim().replace(/\s+/g,' ');
      let ok=0;
      espacios.forEach((correcto,i)=>{
        if(norm(resp[i])===norm(correcto))ok++;
      });
      return parseFloat(((ok/espacios.length)*q.puntaje).toFixed(2));
    }
    default:return 0;
  }
}
