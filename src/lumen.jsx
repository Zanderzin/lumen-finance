import { useState, useCallback, useMemo, useRef } from "react";

// ═══════════════════════════════════════════════════════════════
// DATA LOADER — porta fiel de data_loader.py
// sep=';', decimal=',', skiprows=5, encoding='utf-8'
// ═══════════════════════════════════════════════════════════════
function loadCSV(text) {
  const lines = text.split(/\r?\n/);
  // Pula as 5 primeiras linhas (metadados do Banco Inter) — linha 5 é o header
  const headerLine = lines[5];
  if (!headerLine) throw new Error("Arquivo não possui cabeçalho na linha 6.");
  const headers = headerLine.split(";").map(h => h.trim().replace(/^"|"$/g, ""));
  const rows = [];
  for (let i = 6; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(";").map(c => c.trim().replace(/^"|"$/g, ""));
    if (cols.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] ?? ""; });
    rows.push(row);
  }
  return { headers, rows };
}

// ═══════════════════════════════════════════════════════════════
// PREPROCESSING — porta fiel de preprocessing.py
// ═══════════════════════════════════════════════════════════════
function converterValorMonetario(valorStr) {
  if (valorStr === null || valorStr === undefined || valorStr === "") return NaN;
  let s = String(valorStr).trim().replace(/\s/g, "");
  const nVirgulas = (s.match(/,/g) || []).length;
  const nPontos   = (s.match(/\./g) || []).length;

  if (nVirgulas === 1 && nPontos <= 1) {
    if (nPontos === 1) {
      s = s.replace(".", "").replace(",", ".");
    } else {
      s = s.replace(",", ".");
    }
  } else if (nPontos === 1 && nVirgulas === 0) {
    // já ok
  } else if (nPontos === 1 && nVirgulas >= 1) {
    s = s.replace(/,/g, "");
  } else if (nPontos > 1 && nVirgulas === 0) {
    s = s.replace(/\./g, "");
  } else if (nVirgulas > 1 && nPontos === 0) {
    s = s.replace(/,/g, "");
  } else if (nPontos > 0 && nVirgulas > 0) {
    const ultimaVirgula = s.lastIndexOf(",");
    const ultimoPonto   = s.lastIndexOf(".");
    if (ultimaVirgula > ultimoPonto) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  }

  const v = parseFloat(s);
  return isNaN(v) ? NaN : v;
}

function parseDate(str) {
  if (!str) return null;
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}`);
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

function normalizeColName(name) {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_");
}

function preprocess(rows) {
  const normalized = rows.map(row => {
    const nr = {};
    Object.entries(row).forEach(([k, v]) => { nr[normalizeColName(k)] = v; });
    return nr;
  });

  const colMap = {
    data:     ["data_lancamento", "data", "date"],
    historico:["historico", "historic"],
    descricao:["descricao", "description", "descricao_"],
    valor:    ["valor", "value", "amount"],
    saldo:    ["saldo", "balance"],
  };

  const getCol = (row, aliases) => {
    for (const a of aliases) if (row[a] !== undefined) return row[a];
    return "";
  };

  return normalized
    .map(row => {
      const dataRaw  = getCol(row, colMap.data);
      const descRaw  = getCol(row, colMap.descricao) || getCol(row, colMap.historico);
      const valorRaw = getCol(row, colMap.valor);
      const saldoRaw = getCol(row, colMap.saldo);

      const data  = parseDate(dataRaw);
      const valor = converterValorMonetario(valorRaw);
      const saldo = converterValorMonetario(saldoRaw);
      if (!data || isNaN(valor)) return null;

      const mes    = data.getMonth() + 1;
      const ano    = data.getFullYear();
      const mesAno = `${ano}-${String(mes).padStart(2, "0")}`;
      const semestre = mes <= 6 ? 1 : 2;

      return { data, descricao: descRaw || "", valor, saldo: isNaN(saldo) ? 0 : saldo, mes, ano, mesAno, semestre };
    })
    .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════
// ANALYTICS — porta fiel de analytics.py
// ═══════════════════════════════════════════════════════════════

const PALAVRAS_EMPRESA = [
  "ltda","eireli","sa","s.a","s/a","me","epp","comercio","agencia","restaurante",
  "loja","bar","padaria","mercado","posto","shopping","center","magazine","supermercado",
  "delivery","express","online","store","shop","company","distribuidora","ifood","uber",
  "rappi","ticket","estacio","cinema","teatro","hospital","clinica","farmacia","drogaria",
  "petronorte","taguatinga","mc donald","mcdonald","creperia","pica-pau","magalupay",
  "gmcm","combustivel","brasilia"
];
const NOMES_COMUNS = [
  "jose","maria","joao","ana","antonio","francisco","carlos","paulo","pedro","lucas",
  "marcos","gabriel","rafael","bruno","fernando","rodrigo","patricia","sandra","juliana",
  "fernanda","camila","beatriz","luciana","mariana","amanda","julia","bruna","larissa",
  "natalia","vanessa","marcelo","eduardo","gustavo","felipe","diego","vitor","matheus",
  "thiago","ricardo","roberto","sergio","luis","luciene","bernardo","alexander",
  "alessandra","giovanna","paula","jonatas","alex","teixeira","macedo","francisca",
  "silva","santos","oliveira","souza","costa","ferreira","rodrigues","almeida","nascimento",
  "lima","araujo","ribeiro","carvalho","martins","dias","lopes","gomes","mendes","barros",
  "cardoso","rocha","miranda","duarte","monteiro","freitas","barbosa","campos","aquino",
  "morais","brandao","macena"
];
const PALAVRAS_COMERCIAIS = ["delivery","express","online","store","shop"];

function ehNomePessoa(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase().trim();
  const digits = (t.match(/\d/g) || []).length;
  if (digits > t.length * 0.3) return false;
  for (const p of PALAVRAS_EMPRESA) if (t.includes(p)) return false;
  const palavras = t.split(/\s+/);
  if (palavras.length >= 2) {
    for (const p of palavras) {
      if (p.length > 2 && NOMES_COMUNS.includes(p)) return true;
    }
    if (palavras.length >= 2 && palavras.length <= 4) {
      const validas = palavras.filter(p => p.length > 2);
      if (validas.length >= 2) {
        const temComercial = PALAVRAS_COMERCIAIS.some(pc => t.includes(pc));
        if (!temComercial) return true;
      }
    }
  }
  return false;
}

const CATEGORIAS_KW = {
  "Alimentação": [
    "ifood","quentinhas","sabor","macarons","nino","loucos por burger","biscoitos","rappi",
    "bolos","uber eats","restaurante","lanchonete","padaria","dog","mcdonalds","mc donald",
    "sucoetal","bacio","bauducco","lancheteria","benedito","veloce","creperia","pica-pau",
    "marmitexleo","mercado","taguatinga","supermercado","acougue","hortifruti","pizza",
    "burger","distribuidora","fini","casa do pao","pao","big box","burguer","imperio dos paes",
    "bobs","subway","giraffas","outback","dominos","torta","dona","abbraccio","coco bambu",
    "spoleto","habibs","leonardobianoda","american cookies","sorbe","cafe","bakery",
    "pao de acucar","carrefour","extra","walmart","assai","luzia de fatima miranda","atacadao"
  ],
  "Transporte": [
    "uber","iguatemi","car","combustiveis","estacionament","lyft","cabify","99","taxi",
    "combustivel","gasolina","posto","park","parkshopping","petronorte","shell","boulevard",
    "ipiranga","br petroleo","petrobras","gmcm","estacionamento","valet","onibus","metro",
    "metrô","transporte","pedagio","viacard","carlos ieje de sena","sem parar"
  ],
  "Moradia": [
    "aluguel","condominio","iptu","luz","agua","gas","internet","telefone","neoenergia",
    "caesb","correios","celpe","cemig","copel","light"
  ],
  "Online": [
    "amazon","mercado livre","magalu","magalupay","americanas","submarino","shoptime",
    "casas bahia","netshoes","centauro","aliexpress","ebay","etsy","wish","shein",
    "pagseguro international","zaful"
  ],
  "Mensalidades": [
    "netflix","spotify","disney plus","hbo max","amazon prime","globoplay","fatura",
    "youtube premium","tim","claro","vivo","oi","laricell","apple music","deezer",
    "google drive","dropbox","icloud","one drive","adobe","canva","notion","evernote",
    "slack","zoom","microsoft 365"
  ],
  "Saúde": [
    "farmacia","drogaria","drogasil","pacheco","pague menos","hospital","clinica",
    "laboratorio","medico","dentista","fisioterapia","plano de saude","unimed","amil",
    "sulamerica","bradesco saude","advance fisioterapia"
  ],
  "Educação": [
    "escola","faculdade","universidade","curso","livro","livraria","material escolar",
    "estacio","ceub","unieuro","edx","alura","iesb","projecao","udf","papelaria",
    "udemy","coursera","kaplan","wizard","ccaa","cna","fisk"
  ],
  "Lazer": [
    "cinema","ciatoy","teatro","ri happy","ingresso","ticket","disney","hbo",
    "entretenimento","globoplay","crunchyroll","paramount","steam","playstation","xbox",
    "nintendo","game"
  ],
  "Vestuário": [
    "renner","riachuelo","zara","hering","marisa","pernambucanas","magazine luiza",
    "nike","adidas","decathlon","roupa","calcado","sapato"
  ],
  "Serviços": [
    "salao","barbearia","cabeleireiro","manicure","academia","smartfit","bluefit",
    "bio ritmo","lavanderia","costureira","chaveiro","encanador","eletricista"
  ],
  "Investimentos": [
    "investimento","aplicacao","poupanca","tesouro","cdb","lci","lca","lig liquidez","fundo"
  ],
};
const PALAVRAS_TRANSFERENCIA = ["pix","ted","doc","transferencia","recebido","enviado"];

function categorizarTransacao(descricao) {
  if (!descricao) return "Outros";
  const d = descricao.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const [cat, kws] of Object.entries(CATEGORIAS_KW)) {
    for (const kw of kws) {
      const kwNorm = kw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (d.includes(kwNorm)) return cat;
    }
  }
  for (const p of PALAVRAS_TRANSFERENCIA) if (d.includes(p)) return "Transferências";
  if (ehNomePessoa(descricao)) return "Transferências";
  return "Outros";
}

function calcularMetricasAvancadas(rows) {
  if (!rows.length) return { total_gastos:0,total_entradas:0,ticket_medio:0,maior_gasto:0,gasto_medio_diario:0,categoria_top:"N/A",variacao_gastos:0,variacao_entradas:0 };
  const gastos   = rows.filter(r=>r.valor<0).map(r=>Math.abs(r.valor));
  const entradas = rows.filter(r=>r.valor>0).map(r=>r.valor);
  const datas    = rows.map(r=>r.data).sort((a,b)=>a-b);
  const dias     = Math.max(1,Math.round((datas[datas.length-1]-datas[0])/86400000));
  const metade   = datas[0] ? new Date(datas[0].getTime()+(dias/2)*86400000) : null;
  let varGastos=0, varEntradas=0;
  if (metade) {
    const g1=rows.filter(r=>r.data<metade&&r.valor<0).reduce((s,r)=>s+Math.abs(r.valor),0);
    const g2=rows.filter(r=>r.data>=metade&&r.valor<0).reduce((s,r)=>s+Math.abs(r.valor),0);
    const e1=rows.filter(r=>r.data<metade&&r.valor>0).reduce((s,r)=>s+r.valor,0);
    const e2=rows.filter(r=>r.data>=metade&&r.valor>0).reduce((s,r)=>s+r.valor,0);
    varGastos  =g1>0?((g2-g1)/g1)*100:0;
    varEntradas=e1>0?((e2-e1)/e1)*100:0;
  }
  const catMap={};
  rows.filter(r=>r.valor<0).forEach(r=>{catMap[r.categoria]=(catMap[r.categoria]||0)+Math.abs(r.valor);});
  const catTop=Object.entries(catMap).sort((a,b)=>b[1]-a[1])[0]?.[0]||"N/A";
  const totalGastos=gastos.reduce((s,v)=>s+v,0);
  return {
    total_gastos:totalGastos,
    total_entradas:entradas.reduce((s,v)=>s+v,0),
    ticket_medio:gastos.length?totalGastos/gastos.length:0,
    maior_gasto:gastos.length?Math.max(...gastos):0,
    gasto_medio_diario:totalGastos/dias,
    categoria_top:catTop,
    variacao_gastos:varGastos,
    variacao_entradas:varEntradas,
  };
}

function identificarGastosRecorrentes(rows,minFreq=2) {
  const map={};
  rows.filter(r=>r.valor<0).forEach(r=>{
    const key=r.descricao.toLowerCase().trim().slice(0,30);
    if(!map[key]) map[key]={descricao:r.descricao,count:0,total:0};
    map[key].count++;
    map[key].total+=Math.abs(r.valor);
  });
  return Object.values(map).filter(v=>v.count>=minFreq)
    .map(v=>({...v,valor_medio:v.total/v.count}))
    .sort((a,b)=>b.total-a.total);
}

function analisarTendencias(rows) {
  if(!rows.length) return {tendencia_gastos:"insuficiente",variacao_percentual:0};
  const datas=rows.map(r=>r.data).sort((a,b)=>a-b);
  const dias=Math.round((datas[datas.length-1]-datas[0])/86400000);
  if(dias<30) return {tendencia_gastos:"insuficiente",variacao_percentual:0,dias_analisados:dias};
  const meio=new Date(datas[0].getTime()+(dias/2)*86400000);
  const g1=rows.filter(r=>r.data<meio&&r.valor<0).reduce((s,r)=>s+Math.abs(r.valor),0);
  const g2=rows.filter(r=>r.data>=meio&&r.valor<0).reduce((s,r)=>s+Math.abs(r.valor),0);
  const variacao=g1>0?((g2-g1)/g1)*100:0;
  return {
    tendencia_gastos:variacao>5?"crescente":variacao<-5?"decrescente":"estável",
    variacao_percentual:variacao,
    dias_analisados:dias,
    periodo1_gastos:g1,
    periodo2_gastos:g2,
  };
}

function calcularSaudeFinanceira(rows) {
  const entradas=rows.filter(r=>r.valor>0).reduce((s,r)=>s+r.valor,0);
  const gastos=rows.filter(r=>r.valor<0).reduce((s,r)=>s+Math.abs(r.valor),0);
  if(!entradas) return 0;
  const taxa=((entradas-gastos)/entradas)*100;
  let score=0;
  if(taxa>=30) score+=50; else if(taxa>=20) score+=40; else if(taxa>=10) score+=25; else if(taxa>=0) score+=10;
  const cats=new Set(rows.filter(r=>r.valor<0).map(r=>r.categoria)).size;
  if(cats>=5) score+=25; else if(cats>=3) score+=15; else score+=5;
  const byMes={};
  rows.filter(r=>r.valor<0).forEach(r=>{byMes[r.mesAno]=(byMes[r.mesAno]||0)+Math.abs(r.valor);});
  const vals=Object.values(byMes);
  if(vals.length>1){
    const mean=vals.reduce((s,v)=>s+v,0)/vals.length;
    const std=Math.sqrt(vals.reduce((s,v)=>s+(v-mean)**2,0)/vals.length);
    const cv=std/mean;
    if(cv<0.2) score+=25; else if(cv<0.4) score+=15; else score+=5;
  }
  return Math.min(score,100);
}

// ═══════════════════════════════════════════════════════════════
// FORMATAÇÃO
// ═══════════════════════════════════════════════════════════════
const fmtBRL = v => new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(v);
const fmtDate = d => d instanceof Date ? d.toLocaleDateString("pt-BR") : "";
const monthLabel = key => {
  const [y,m]=key.split("-");
  return `${["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"][parseInt(m)-1]}/${y.slice(2)}`;
};

// ═══════════════════════════════════════════════════════════════
// MINI CHARTS
// ═══════════════════════════════════════════════════════════════
function Sparkline({data, labels, color="#6ee7b7", height=100}) {
  if(!data||data.length<2) return null;

  // Layout: margem esquerda para valores Y, margem inferior para labels X
  const ML=48, MR=12, MT=12, MB=28;
  const W=600, H=height+MT+MB;
  const cW=W-ML-MR, cH=height-MT; // área do gráfico

  const min=Math.min(...data), max=Math.max(...data), range=max-min||1;
  // X: pontos igualmente espaçados, alinhados com os labels
  const xOf=i => ML + (i/(data.length-1))*cW;
  const yOf=v => MT + cH - ((v-min)/range)*cH*0.88;

  const pts=data.map((v,i)=>[xOf(i), yOf(v)]);
  const linePath=pts.map((p,i)=>`${i===0?"M":"L"}${p[0]},${p[1]}`).join(" ");
  const areaPath=`${linePath} L${xOf(data.length-1)},${MT+cH} L${xOf(0)},${MT+cH} Z`;

  const id=`sg${color.replace(/[^a-z0-9]/gi,"")}${height}`;

  // Grid horizontal: 4 linhas
  const gridLines=4;
  const gridVals=Array.from({length:gridLines+1},(_,i)=>min+(range/gridLines)*i);

  // Decide quantos labels mostrar (máx ~12 para não sobrepor)
  const maxLabels=12;
  const step=Math.ceil((labels||[]).length/maxLabels);

  return(
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H,display:"block"}}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>

      {/* Grid horizontal */}
      {gridVals.map((v,i)=>{
        const y=yOf(v);
        return(
          <g key={i}>
            <line x1={ML} y1={y} x2={ML+cW} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1"/>
            <text x={ML-6} y={y+4} textAnchor="end" fontSize="9" fill="#404040" fontFamily="DM Sans,sans-serif">
              {v>=1000?`${(v/1000).toFixed(0)}k`:v.toFixed(0)}
            </text>
          </g>
        );
      })}

      {/* Grid vertical + labels X — alinhados com os pontos */}
      {(labels||[]).map((l,i)=>{
        if(i%step!==0 && i!==labels.length-1) return null;
        const x=xOf(i);
        return(
          <g key={i}>
            <line x1={x} y1={MT} x2={x} y2={MT+cH} stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>
            <text x={x} y={H-6} textAnchor="middle" fontSize="9" fill="#404040" fontFamily="DM Sans,sans-serif">{l}</text>
          </g>
        );
      })}

      {/* Área preenchida */}
      <path d={areaPath} fill={`url(#${id})`}/>

      {/* Linha */}
      <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>

      {/* Pontos */}
      {pts.map((p,i)=>(
        <circle key={i} cx={p[0]} cy={p[1]} r="3" fill={color} stroke="#0c0c0c" strokeWidth="1.5"/>
      ))}
    </svg>
  );
}

function BarChart({data,labels,colors,height=150}) {
  if(!data||!data.length) return null;
  const MB=labels?22:0, MT=8;
  const W=600, H=height+MB;
  const ML=8, MR=8;
  const cW=W-ML-MR, cH=height-MT;
  const max=Math.max(...data.map(d=>Math.abs(d.value)),1);
  const n=data.length;
  const gap=4, bw=(cW-gap*(n+1))/n;
  const maxLabels=14;
  const step=Math.ceil(n/maxLabels);
  return(
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H,display:"block"}}>
      {/* Grid horizontal */}
      {[0.25,0.5,0.75,1].map(f=>{
        const y=MT+cH-(f*cH*0.92);
        return <line key={f} x1={ML} y1={y} x2={ML+cW} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1"/>;
      })}
      {data.map((d,i)=>{
        const bh=(Math.abs(d.value)/max)*cH*0.92;
        const x=ML+gap+i*(bw+gap);
        const cx=x+bw/2;
        const c=Array.isArray(colors)?colors[i%colors.length]:(colors||"#6ee7b7");
        return(
          <g key={i}>
            <rect x={x} y={MT+cH-bh} width={bw} height={bh} fill={c} opacity="0.85" rx="2"/>
            {labels&&i%step===0&&(
              <text x={cx} y={H-4} textAnchor="middle" fontSize="9" fill="#404040" fontFamily="DM Sans,sans-serif">{labels[i]}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function DonutChart({data,colors}) {
  if(!data.length) return null;
  const total=data.reduce((s,d)=>s+d.value,0);
  const r=68,cx=88,cy=88,W=176;
  let cum=-90;
  const toR=d=>d*Math.PI/180;
  const slices=data.map((d,i)=>{
    const pct=d.value/total,ang=pct*360,s=cum;cum+=ang;
    const x1=cx+r*Math.cos(toR(s)),y1=cy+r*Math.sin(toR(s));
    const x2=cx+r*Math.cos(toR(s+ang)),y2=cy+r*Math.sin(toR(s+ang));
    return{path:`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${ang>180?1:0},1 ${x2},${y2} Z`,color:colors[i%colors.length]};
  });
  return(
    <svg viewBox={`0 0 ${W} ${W}`} style={{width:"100%",maxWidth:176}}>
      {slices.map((s,i)=><path key={i} d={s.path} fill={s.color} opacity="0.9"/>)}
      <circle cx={cx} cy={cy} r={r-28} fill="#0a0a0a"/>
    </svg>
  );
}

function ScoreRing({score}) {
  const r=52,cx=64,cy=64,circ=2*Math.PI*r;
  const dash=(score/100)*circ;
  const color=score>=70?"#6ee7b7":score>=40?"#facc15":"#f87171";
  return(
    <svg viewBox="0 0 128 128" style={{width:128,height:128}}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="12"/>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="12"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}/>
      <text x={cx} y={cy+7} textAnchor="middle" fill={color} fontSize="22" fontWeight="800" fontFamily="DM Sans,sans-serif">{score}</text>
      <text x={cx} y={cy+22} textAnchor="middle" fill="#444" fontSize="9" fontFamily="DM Sans,sans-serif">/ 100</text>
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════
// ESTILOS
// ═══════════════════════════════════════════════════════════════
const CAT_COLORS=["#6ee7b7","#60a5fa","#f472b6","#fb923c","#a78bfa","#facc15","#34d399","#38bdf8","#e879f9","#4ade80","#f87171","#94a3b8"];

const GLOBAL_CSS=`
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700;9..40,800&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
html{font-size:17px;}
body,html{background:#080808;}
input,select,button,textarea{font-family:'DM Sans',sans-serif;}
::-webkit-scrollbar{width:5px;height:5px;}
::-webkit-scrollbar-track{background:#0a0a0a;}
::-webkit-scrollbar-thumb{background:#1c1c1c;border-radius:3px;}
.ltr:hover td{background:rgba(255,255,255,0.013)!important;}
.hcard:hover{border-color:rgba(110,231,183,0.18)!important;transform:translateY(-2px);}
@keyframes fadeUp{from{opacity:0;transform:translateY(18px);}to{opacity:1;transform:translateY(0);}}
@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}
@keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
@keyframes pulse{0%,100%{opacity:0.4;}50%{opacity:1;}}
@keyframes dashIn{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}
.anim-fadeup{animation:fadeUp 0.55s cubic-bezier(0.22,1,0.36,1) both;}
.anim-fadein{animation:fadeIn 0.4s ease both;}
.anim-dash{animation:dashIn 0.5s cubic-bezier(0.22,1,0.36,1) both;}
.anim-kpi>*{animation:fadeUp 0.5s cubic-bezier(0.22,1,0.36,1) both;}
.anim-kpi>*:nth-child(1){animation-delay:0.05s;}
.anim-kpi>*:nth-child(2){animation-delay:0.1s;}
.anim-kpi>*:nth-child(3){animation-delay:0.15s;}
.anim-kpi>*:nth-child(4){animation-delay:0.2s;}
.anim-kpi>*:nth-child(5){animation-delay:0.25s;}
.anim-kpi>*:nth-child(6){animation-delay:0.3s;}
.anim-kpi>*:nth-child(7){animation-delay:0.35s;}
.anim-kpi>*:nth-child(8){animation-delay:0.4s;}
@media(max-width:860px){
  .lsidebar{display:none!important;}
  .lmain{padding:24px 16px!important;}
  .lg2{grid-template-columns:1fr!important;}
  .lkpi{grid-template-columns:1fr 1fr!important;}
}
`;

const S={
  app:{minHeight:"100vh",background:"#080808",color:"#f0ebe4",fontFamily:"'DM Sans',sans-serif"},
  nav:{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"22px 52px",borderBottom:"1px solid rgba(255,255,255,0.05)",position:"sticky",top:0,background:"rgba(8,8,8,0.95)",backdropFilter:"blur(20px)",zIndex:100},
  logo:{fontSize:"1.3rem",fontWeight:800,letterSpacing:"-0.03em",color:"#f0ebe4"},
  dot:{color:"#6ee7b7"},
  pill:{background:"#6ee7b7",color:"#080808",border:"none",borderRadius:100,padding:"10px 22px",fontWeight:700,fontSize:"0.88rem",cursor:"pointer"},
  // Hero
  hero:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"86vh",padding:"0 24px",textAlign:"center"},
  eyebrow:{fontSize:"0.75rem",fontWeight:700,letterSpacing:"0.16em",textTransform:"uppercase",color:"#6ee7b7",marginBottom:18},
  h1:{fontSize:"clamp(3rem,8vw,6rem)",fontWeight:800,letterSpacing:"-0.04em",lineHeight:1.02,margin:"0 0 18px",background:"linear-gradient(135deg,#f0ebe4 0%,#666 100%)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"},
  sub:{fontSize:"1.1rem",color:"#555",maxWidth:460,lineHeight:1.65,margin:"0 0 48px"},
  zone:{border:"1px solid rgba(110,231,183,0.22)",borderRadius:18,padding:"50px 68px",maxWidth:520,width:"100%",cursor:"pointer",transition:"all 0.2s",background:"rgba(110,231,183,0.02)"},
  zoneH:{border:"1px solid rgba(110,231,183,0.55)",background:"rgba(110,231,183,0.06)"},
  // Dash
  dash:{display:"flex",minHeight:"calc(100vh - 73px)"},
  sidebar:{width:272,minWidth:272,borderRight:"1px solid rgba(255,255,255,0.05)",padding:"36px 26px",display:"flex",flexDirection:"column",gap:28,background:"#080808",position:"sticky",top:73,height:"calc(100vh - 73px)",overflowY:"auto"},
  sLbl:{fontSize:"0.68rem",fontWeight:700,letterSpacing:"0.13em",textTransform:"uppercase",color:"#343434",marginBottom:9},
  fInp:{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:9,padding:"10px 14px",color:"#f0ebe4",fontSize:"0.88rem",width:"100%",outline:"none"},
  chkR:{display:"flex",alignItems:"center",gap:9,cursor:"pointer",marginBottom:5},
  chkB:{width:16,height:16,borderRadius:4,border:"1px solid rgba(255,255,255,0.13)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.15s"},
  chkBA:{background:"#6ee7b7",border:"1px solid #6ee7b7"},
  chkL:{fontSize:"0.85rem",color:"#505050",transition:"color 0.15s"},
  chkLA:{color:"#c0c0c0"},
  sBtn:{background:"transparent",border:"1px solid rgba(255,255,255,0.07)",borderRadius:7,padding:"5px 11px",color:"#404040",fontSize:"0.72rem",cursor:"pointer"},
  // Main
  main:{flex:1,padding:"44px 56px",overflow:"hidden",minWidth:0},
  pT:{fontSize:"clamp(1.8rem,3vw,2.6rem)",fontWeight:800,letterSpacing:"-0.04em",marginBottom:8},
  pS:{fontSize:"0.9rem",color:"#404040",marginBottom:44},
  // Tabs
  tabs:{display:"flex",gap:2,marginBottom:36,borderBottom:"1px solid rgba(255,255,255,0.05)",overflowX:"auto",msOverflowStyle:"none",scrollbarWidth:"none"},
  tab:{padding:"12px 20px",background:"transparent",border:"none",color:"#444",fontSize:"0.9rem",fontWeight:500,cursor:"pointer",borderBottom:"2px solid transparent",marginBottom:-1,whiteSpace:"nowrap",transition:"all 0.15s"},
  tabA:{color:"#f0ebe4",borderBottom:"2px solid #6ee7b7"},
  // KPI
  kpiG:{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))",gap:14,marginBottom:44},
  kpiC:{background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.05)",borderRadius:14,padding:"26px 22px",transition:"all 0.2s",cursor:"default"},
  kpiL:{fontSize:"0.68rem",fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"#353535",marginBottom:12},
  kpiV:{fontSize:"1.85rem",fontWeight:800,letterSpacing:"-0.03em",color:"#f0ebe4",lineHeight:1},
  kpiD:{fontSize:"0.78rem",marginTop:8},
  kPos:{color:"#6ee7b7"},kNeg:{color:"#f87171"},kNeu:{color:"#505050"},
  // Card
  card:{background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.05)",borderRadius:14,padding:"26px",overflow:"hidden",transition:"all 0.2s"},
  cT:{fontSize:"0.68rem",fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"#353535",marginBottom:20},
  g2:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:18},
  g13:{display:"grid",gridTemplateColumns:"1.2fr 2fr",gap:16,marginBottom:18},
  // Table
  tbl:{width:"100%",borderCollapse:"collapse"},
  th:{fontSize:"0.66rem",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"#303030",textAlign:"left",padding:"0 14px 14px",borderBottom:"1px solid rgba(255,255,255,0.05)"},
  tr:{borderBottom:"1px solid rgba(255,255,255,0.03)"},
  td:{padding:"13px 14px",fontSize:"0.88rem",color:"#606060"},
  tdM:{padding:"13px 14px",fontSize:"0.88rem",color:"#c8c8c8",fontWeight:500},
  badge:{display:"inline-block",padding:"3px 10px",borderRadius:100,fontSize:"0.72rem",fontWeight:600,background:"rgba(110,231,183,0.09)",color:"#6ee7b7"},
  barH:{display:"flex",justifyContent:"space-between",marginBottom:6},
  barL:{fontSize:"0.84rem",color:"#808080"},
  barV:{fontSize:"0.84rem",color:"#f0ebe4",fontWeight:600},
  barT:{height:4,background:"rgba(255,255,255,0.05)",borderRadius:4,marginBottom:15},
  barF:{height:4,borderRadius:4},
  legI:{display:"flex",alignItems:"center",gap:8,marginBottom:9},
  legD:{width:8,height:8,borderRadius:"50%",flexShrink:0},
  legL:{fontSize:"0.82rem",color:"#707070"},
  legV:{fontSize:"0.82rem",color:"#f0ebe4",fontWeight:600,marginLeft:"auto"},
  iGrid:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:18},
  iCard:{borderRadius:12,padding:"18px 22px",borderLeft:"3px solid",background:"rgba(255,255,255,0.016)"},
  iText:{fontSize:"0.88rem",color:"#888",lineHeight:1.65},
  fRow:{display:"flex",gap:10,marginBottom:20,flexWrap:"wrap"},
  fSearch:{flex:1,minWidth:160,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:9,padding:"10px 14px",color:"#f0ebe4",fontSize:"0.88rem",outline:"none"},
  fSel:{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:9,padding:"10px 14px",color:"#f0ebe4",fontSize:"0.88rem",outline:"none"},
  dlBtn:{background:"rgba(110,231,183,0.07)",border:"1px solid rgba(110,231,183,0.16)",borderRadius:9,padding:"10px 18px",color:"#6ee7b7",fontSize:"0.88rem",fontWeight:600,cursor:"pointer"},
};

// ═══════════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════════
export default function LumenApp() {
  const [data,setData]=useState(null);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const [loadingStep,setLoadingStep]=useState(0);
  const [showDash,setShowDash]=useState(false);
  const [hover,setHover]=useState(false);
  const [activeTab,setActiveTab]=useState(0);
  const [filterDe,setFilterDe]=useState("");
  const [filterAte,setFilterAte]=useState("");
  const [filterCats,setFilterCats]=useState([]);
  const [filterTipo,setFilterTipo]=useState("todas");
  const [searchTx,setSearchTx]=useState("");
  const [sortTx,setSortTx]=useState("data_desc");
  const fileRef=useRef();

  const processFile=useCallback((file)=>{
    if(!file) return;
    setLoading(true);setError("");
    const reader=new FileReader();
    reader.onload=e=>{
      try {
        setLoadingStep(1);
        setTimeout(()=>{
          try{
            const {rows}=loadCSV(e.target.result);
            if(!rows.length) throw new Error("Nenhuma linha encontrada após o cabeçalho.");
            setLoadingStep(2);
            setTimeout(()=>{
              try{
                const processed=preprocess(rows);
                if(!processed.length) throw new Error("Não foi possível interpretar os dados. Verifique o formato do arquivo.");
                setLoadingStep(3);
                setTimeout(()=>{
                  const withCat=processed.map(r=>({...r,categoria:categorizarTransacao(r.descricao)}));
                  const allC=[...new Set(withCat.map(r=>r.categoria))].sort();
                  setFilterCats(allC);
                  const dates=withCat.map(r=>r.data).sort((a,b)=>a-b);
                  setFilterDe(dates[0].toISOString().split("T")[0]);
                  setFilterAte(dates[dates.length-1].toISOString().split("T")[0]);
                  setActiveTab(0);
                  setLoadingStep(4);
                  setTimeout(()=>{ setData(withCat); setShowDash(false); requestAnimationFrame(()=>setShowDash(true)); setLoading(false); setLoadingStep(0); },500);
                },600);
              }catch(err){setError(err.message);setLoading(false);setLoadingStep(0);}
            },700);
          }catch(err){setError(err.message);setLoading(false);setLoadingStep(0);}
        },400);
      } catch(err){setError(err.message);setLoading(false);setLoadingStep(0);}
    };
    reader.onerror=()=>{setError("Erro ao ler o arquivo.");setLoading(false);};
    reader.readAsText(file,"utf-8");
  },[]);

  const onDrop=useCallback(e=>{
    e.preventDefault();setHover(false);
    processFile(e.dataTransfer.files[0]);
  },[processFile]);

  const filtered=useMemo(()=>{
    if(!data) return [];
    let d=data;
    if(filterDe)  d=d.filter(r=>r.data>=new Date(filterDe));
    if(filterAte){const ate=new Date(filterAte);ate.setDate(ate.getDate()+1);d=d.filter(r=>r.data<ate);}
    if(filterCats.length) d=d.filter(r=>filterCats.includes(r.categoria));
    if(filterTipo==="gastos")   d=d.filter(r=>r.valor<0);
    if(filterTipo==="entradas") d=d.filter(r=>r.valor>0);
    return d;
  },[data,filterDe,filterAte,filterCats,filterTipo]);

  const metricas   =useMemo(()=>calcularMetricasAvancadas(filtered),[filtered]);
  const tendencias =useMemo(()=>analisarTendencias(filtered),[filtered]);
  const score      =useMemo(()=>calcularSaudeFinanceira(filtered),[filtered]);
  const recorrentes=useMemo(()=>identificarGastosRecorrentes(filtered),[filtered]);

  const byMonth=useMemo(()=>{
    const map={};
    filtered.forEach(r=>{
      if(!map[r.mesAno]) map[r.mesAno]={gastos:0,entradas:0};
      if(r.valor<0) map[r.mesAno].gastos+=Math.abs(r.valor);
      else          map[r.mesAno].entradas+=r.valor;
    });
    return Object.entries(map).sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>({mes:k,label:monthLabel(k),...v}));
  },[filtered]);

  const byCategoria=useMemo(()=>{
    const map={};
    filtered.filter(r=>r.valor<0).forEach(r=>{map[r.categoria]=(map[r.categoria]||0)+Math.abs(r.valor);});
    const total=Object.values(map).reduce((s,v)=>s+v,0);
    return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([label,value])=>({label,value,pct:total?(value/total)*100:0}));
  },[filtered]);

  const txDisplay=useMemo(()=>{
    let d=[...filtered];
    if(searchTx) d=d.filter(r=>r.descricao.toLowerCase().includes(searchTx.toLowerCase()));
    if(sortTx==="data_desc")  d.sort((a,b)=>b.data-a.data);
    if(sortTx==="data_asc")   d.sort((a,b)=>a.data-b.data);
    if(sortTx==="valor_desc") d.sort((a,b)=>b.valor-a.valor);
    if(sortTx==="valor_asc")  d.sort((a,b)=>a.valor-b.valor);
    return d.slice(0,120);
  },[filtered,searchTx,sortTx]);

  const allCats=useMemo(()=>data?[...new Set(data.map(r=>r.categoria))].sort():[], [data]);
  const toggleCat=cat=>setFilterCats(prev=>prev.includes(cat)?prev.filter(c=>c!==cat):[...prev,cat]);

  const downloadCSV=()=>{
    const head="data;descricao;categoria;valor;saldo";
    const body=filtered.map(r=>[fmtDate(r.data),r.descricao,r.categoria,r.valor,r.saldo].join(";"));
    const blob=new Blob([[head,...body].join("\n")],{type:"text/csv"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="lumen_extrato.csv";a.click();
  };

  const saldoLiquido=metricas.total_entradas-metricas.total_gastos;
  const taxaPoupanca=metricas.total_entradas>0?(saldoLiquido/metricas.total_entradas)*100:0;
  const dataMin=filtered.length?filtered.reduce((m,r)=>r.data<m?r.data:m,filtered[0].data):null;
  const dataMax=filtered.length?filtered.reduce((m,r)=>r.data>m?r.data:m,filtered[0].data):null;

  const TABS=["Visão Geral","Tendências","Categorias","Recorrências","Insights","Transações"];

  // ── UPLOAD SCREEN ──────────────────────────────────────────
  if(!data) return(
    <div style={S.app}>
      <style>{GLOBAL_CSS}</style>
      <nav style={S.nav}>
        <div style={S.logo}>lumen<span style={S.dot}>.</span></div>
        <span style={{fontSize:"0.74rem",color:"#2e2e2e"}}>Banco Inter · CSV</span>
      </nav>
      <div style={S.hero}>
        <p style={S.eyebrow}>Dashboard Financeiro Pessoal</p>
        <h1 style={S.h1}>Seu dinheiro,<br/>mais claro.</h1>
        <p style={S.sub}>Faça upload do extrato do Banco Inter e obtenha uma análise completa das suas finanças em segundos.</p>
        {loading ? (
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:32,animation:"fadeIn 0.3s ease"}}>
            {/* Spinner */}
            <div style={{position:"relative",width:80,height:80}}>
              <div style={{position:"absolute",inset:0,borderRadius:"50%",border:"2px solid rgba(110,231,183,0.1)"}}/>
              <div style={{position:"absolute",inset:0,borderRadius:"50%",border:"2px solid transparent",borderTopColor:"#6ee7b7",animation:"spin 0.9s linear infinite"}}/>
              <div style={{position:"absolute",inset:8,borderRadius:"50%",border:"2px solid transparent",borderTopColor:"rgba(110,231,183,0.4)",animation:"spin 1.4s linear infinite reverse"}}/>
              <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.5rem"}}>💡</div>
            </div>
            {/* Steps */}
            <div style={{display:"flex",flexDirection:"column",gap:12,width:300}}>
              {[
                [1,"Lendo o arquivo CSV"],
                [2,"Processando transações"],
                [3,"Categorizando gastos"],
                [4,"Gerando análises"],
              ].map(([step,label])=>{
                const done=loadingStep>step, active=loadingStep===step;
                return(
                  <div key={step} style={{display:"flex",alignItems:"center",gap:12,opacity:done||active?1:0.25,transition:"opacity 0.3s"}}>
                    <div style={{width:22,height:22,borderRadius:"50%",border:`2px solid ${done?"#6ee7b7":active?"#6ee7b7":"rgba(255,255,255,0.1)"}`,background:done?"#6ee7b7":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.3s"}}>
                      {done
                        ? <span style={{color:"#080808",fontSize:"0.65rem",fontWeight:900}}>✓</span>
                        : active
                        ? <div style={{width:8,height:8,borderRadius:"50%",background:"#6ee7b7",animation:"pulse 1s ease infinite"}}/>
                        : null}
                    </div>
                    <span style={{fontSize:"0.88rem",color:done||active?"#f0ebe4":"#444",transition:"color 0.3s"}}>{label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <div
              style={{...S.zone,...(hover?S.zoneH:{})}}
              onDragOver={e=>{e.preventDefault();setHover(true);}}
              onDragLeave={()=>setHover(false)}
              onDrop={onDrop}
              onClick={()=>fileRef.current.click()}
            >
              <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>processFile(e.target.files[0])}/>
              <div style={{fontSize:"2rem",marginBottom:12}}>📂</div>
              <div style={{fontSize:"0.95rem",fontWeight:600,marginBottom:8,color:"#f0ebe4"}}>Arraste o CSV ou clique para selecionar</div>
              <div style={{fontSize:"0.8rem",color:"#404040"}}>Extrato do app Banco Inter · formato .csv</div>
            </div>
            {error&&<p style={{marginTop:14,fontSize:"0.8rem",color:"#f87171",maxWidth:460,textAlign:"center"}}>{error}</p>}
            <p style={{marginTop:18,fontSize:"0.68rem",color:"#252525"}}>Nenhum dado é enviado a servidores. Tudo é processado localmente no seu navegador.</p>
          </>
        )}
      </div>
    </div>
  );

  // ── DASHBOARD ──────────────────────────────────────────────
  return(
    <div style={S.app}>
      <style>{GLOBAL_CSS}</style>
      <nav style={S.nav}>
        <div style={S.logo}>lumen<span style={S.dot}>.</span></div>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <span style={{fontSize:"0.74rem",color:"#333"}}>{filtered.length} transações · {fmtBRL(metricas.total_gastos)} gastos</span>
          <button style={S.pill} onClick={()=>{setData(null);setError("");}}>Novo extrato</button>
        </div>
      </nav>

      <div style={{...S.dash,animation:showDash?"dashIn 0.5s cubic-bezier(0.22,1,0.36,1) both":"none"}} className="anim-fadein">
        {/* SIDEBAR */}
        <aside style={S.sidebar} className="lsidebar">
          <div>
            <div style={S.sLbl}>Período</div>
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              <input type="date" style={S.fInp} value={filterDe} onChange={e=>setFilterDe(e.target.value)}/>
              <input type="date" style={S.fInp} value={filterAte} onChange={e=>setFilterAte(e.target.value)}/>
            </div>
          </div>
          <div>
            <div style={S.sLbl}>Tipo</div>
            {[["todas","Todas"],["gastos","Gastos"],["entradas","Entradas"]].map(([v,l])=>(
              <div key={v} style={S.chkR} onClick={()=>setFilterTipo(v)}>
                <div style={{...S.chkB,...(filterTipo===v?S.chkBA:{})}}>{filterTipo===v&&<span style={{color:"#080808",fontSize:"0.52rem",fontWeight:900}}>✓</span>}</div>
                <span style={{...S.chkL,...(filterTipo===v?S.chkLA:{})}}>{l}</span>
              </div>
            ))}
          </div>
          <div>
            <div style={{...S.sLbl,marginBottom:10}}>Categorias</div>
            <div style={{display:"flex",gap:6,marginBottom:10}}>
              <button style={S.sBtn} onClick={()=>setFilterCats(allCats)}>Todas</button>
              <button style={S.sBtn} onClick={()=>setFilterCats([])}>Nenhuma</button>
            </div>
            {allCats.map(cat=>(
              <div key={cat} style={S.chkR} onClick={()=>toggleCat(cat)}>
                <div style={{...S.chkB,...(filterCats.includes(cat)?S.chkBA:{})}}>{filterCats.includes(cat)&&<span style={{color:"#080808",fontSize:"0.52rem",fontWeight:900}}>✓</span>}</div>
                <span style={{...S.chkL,...(filterCats.includes(cat)?S.chkLA:{})}}>{cat}</span>
              </div>
            ))}
          </div>
        </aside>

        {/* MAIN */}
        <main style={S.main} className="lmain">
          <div style={S.tabs} className="notabs">
            {TABS.map((t,i)=>(
              <button key={t} style={{...S.tab,...(activeTab===i?S.tabA:{})}} onClick={()=>setActiveTab(i)}>{t}</button>
            ))}
          </div>

          {/* ══ VISÃO GERAL ══ */}
          {activeTab===0&&<>
            <h1 style={S.pT}>Visão Geral</h1>
            <p style={S.pS}>{dataMin&&dataMax?`${fmtDate(dataMin)} → ${fmtDate(dataMax)}`:"Período selecionado"}</p>
            <div style={S.kpiG} className="lkpi anim-kpi">
              {[
                {l:"Total de Gastos",  v:fmtBRL(metricas.total_gastos),  d:`${metricas.variacao_gastos>0?"↑":"↓"} ${Math.abs(metricas.variacao_gastos).toFixed(1)}% vs período anterior`,neg:true},
                {l:"Total de Entradas",v:fmtBRL(metricas.total_entradas), d:`${metricas.variacao_entradas>0?"↑":"↓"} ${Math.abs(metricas.variacao_entradas).toFixed(1)}% vs período anterior`,neg:false},
                {l:"Saldo Líquido",    v:fmtBRL(saldoLiquido),           d:saldoLiquido>=0?"Positivo ↑":"Negativo ↓",neg:saldoLiquido<0},
                {l:"Taxa de Poupança", v:`${taxaPoupanca.toFixed(1)}%`,   d:taxaPoupanca>=20?"Meta de 20% atingida ✓":"Meta: 20%",neg:taxaPoupanca<0},
                {l:"Maior Gasto",      v:fmtBRL(metricas.maior_gasto),    d:"Transação individual",neg:false},
                {l:"Ticket Médio",     v:fmtBRL(metricas.ticket_medio),   d:"Por transação de gasto",neg:false},
                {l:"Gasto Médio/Dia",  v:fmtBRL(metricas.gasto_medio_diario),d:"No período",neg:false},
                {l:"Categoria Top",    v:metricas.categoria_top,          d:byCategoria[0]?fmtBRL(byCategoria[0].value):"—",neg:false},
              ].map(k=>(
                <div key={k.l} style={S.kpiC} className="hcard">
                  <div style={S.kpiL}>{k.l}</div>
                  <div style={S.kpiV}>{k.v}</div>
                  <div style={{...S.kpiD,...(k.neg?S.kNeg:S.kPos)}}>{k.d}</div>
                </div>
              ))}
            </div>
            <div style={S.g2} className="lg2">
              <div style={S.card}>
                <div style={S.cT}>Gastos por mês</div>
                <BarChart data={byMonth.map(m=>({value:m.gastos}))} labels={byMonth.map(m=>m.label)} colors={["#f87171"]} height={130}/>
              </div>
              <div style={S.card}>
                <div style={S.cT}>Saldo líquido por mês</div>
                <BarChart data={byMonth.map(m=>({value:m.entradas-m.gastos}))} labels={byMonth.map(m=>m.label)} colors={byMonth.map(m=>m.entradas-m.gastos>=0?"#6ee7b7":"#f87171")} height={130}/>
              </div>
            </div>
          </>}

          {/* ══ TENDÊNCIAS ══ */}
          {activeTab===1&&<>
            <h1 style={S.pT}>Tendências</h1>
            <p style={S.pS}>Evolução mensal de gastos, entradas e saldo</p>
            <div style={S.g2} className="lg2">
              <div style={S.card}>
                <div style={S.cT}>Gastos mensais</div>
                <Sparkline data={byMonth.map(m=>m.gastos)} labels={byMonth.map(m=>m.label)} color="#f87171" height={100}/>
              </div>
              <div style={S.card}>
                <div style={S.cT}>Entradas mensais</div>
                <Sparkline data={byMonth.map(m=>m.entradas)} labels={byMonth.map(m=>m.label)} color="#6ee7b7" height={100}/>
              </div>
            </div>
            <div style={{...S.card,marginBottom:16}}>
              <div style={S.cT}>Taxa de poupança mensal</div>
              <Sparkline data={byMonth.map(m=>m.entradas>0?((m.entradas-m.gastos)/m.entradas)*100:0)} labels={byMonth.map(m=>m.label)} color="#a78bfa" height={100}/>
              <div style={{marginTop:8,paddingTop:12,borderTop:"1px solid rgba(255,255,255,0.04)",fontSize:"0.72rem",color:"#505050"}}>
                Meta: 20% — Atingida em {byMonth.filter(m=>m.entradas>0&&((m.entradas-m.gastos)/m.entradas)*100>=20).length} de {byMonth.length} meses
              </div>
            </div>
            <div style={S.card}>
              <div style={S.cT}>Comparativo mensal detalhado</div>
              <div style={{overflowX:"auto"}}>
                <table style={S.tbl}>
                  <thead><tr>{["Mês","Entradas","Gastos","Saldo","Taxa poupança"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {byMonth.map(m=>{
                      const s=m.entradas-m.gastos,t=m.entradas>0?(s/m.entradas)*100:0;
                      return<tr key={m.mes} style={S.tr} className="ltr">
                        <td style={S.tdM}>{m.label}</td>
                        <td style={{...S.td,color:"#6ee7b7"}}>{fmtBRL(m.entradas)}</td>
                        <td style={{...S.td,color:"#f87171"}}>{fmtBRL(m.gastos)}</td>
                        <td style={{...S.td,color:s>=0?"#6ee7b7":"#f87171"}}>{fmtBRL(s)}</td>
                        <td style={S.td}>{t.toFixed(1)}%</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>}

          {/* ══ CATEGORIAS ══ */}
          {activeTab===2&&<>
            <h1 style={S.pT}>Categorias</h1>
            <p style={S.pS}>Distribuição dos gastos por categoria</p>
            <div style={S.g13} className="lg2">
              <div style={S.card}>
                <div style={S.cT}>Distribuição</div>
                <div style={{display:"flex",justifyContent:"center",marginBottom:14}}>
                  <DonutChart data={byCategoria.slice(0,10)} colors={CAT_COLORS}/>
                </div>
                {byCategoria.map((c,i)=>(
                  <div key={c.label} style={S.legI}>
                    <div style={{...S.legD,background:CAT_COLORS[i%CAT_COLORS.length]}}/>
                    <span style={S.legL}>{c.label}</span>
                    <span style={S.legV}>{c.pct.toFixed(1)}%</span>
                  </div>
                ))}
              </div>
              <div style={S.card}>
                <div style={S.cT}>Ranking de gastos</div>
                {byCategoria.map((c,i)=>(
                  <div key={c.label}>
                    <div style={S.barH}><span style={S.barL}>{c.label}</span><span style={S.barV}>{fmtBRL(c.value)}</span></div>
                    <div style={S.barT}><div style={{...S.barF,width:`${c.pct}%`,background:CAT_COLORS[i%CAT_COLORS.length]}}/></div>
                  </div>
                ))}
              </div>
            </div>
            <div style={S.card}>
              <div style={S.cT}>Detalhamento por categoria</div>
              <div style={{overflowX:"auto"}}>
                <table style={S.tbl}>
                  <thead><tr>{["Categoria","Total","Transações","Ticket médio","% do total"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {byCategoria.map((c,i)=>{
                      const txs=filtered.filter(r=>r.valor<0&&r.categoria===c.label);
                      return<tr key={c.label} style={S.tr} className="ltr">
                        <td style={S.tdM}><span style={{...S.badge,background:`${CAT_COLORS[i%CAT_COLORS.length]}18`,color:CAT_COLORS[i%CAT_COLORS.length]}}>{c.label}</span></td>
                        <td style={{...S.td,color:"#f87171"}}>{fmtBRL(c.value)}</td>
                        <td style={S.td}>{txs.length}</td>
                        <td style={S.td}>{fmtBRL(txs.length?c.value/txs.length:0)}</td>
                        <td style={S.td}>{c.pct.toFixed(1)}%</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>}

          {/* ══ RECORRÊNCIAS ══ */}
          {activeTab===3&&<>
            <h1 style={S.pT}>Recorrências</h1>
            <p style={S.pS}>Gastos que aparecem repetidamente no extrato</p>
            {!recorrentes.length
              ?<div style={{...S.card,textAlign:"center",padding:"56px 24px"}}><p style={{color:"#404040"}}>Nenhum gasto recorrente identificado no período.</p></div>
              :<>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:12,marginBottom:16}} className="lkpi">
                  {recorrentes.slice(0,6).map((r,i)=>(
                    <div key={r.descricao} style={{...S.kpiC,borderLeft:`3px solid ${CAT_COLORS[i%CAT_COLORS.length]}`}}>
                      <div style={S.kpiL}>{categorizarTransacao(r.descricao)}</div>
                      <div style={{fontSize:"0.84rem",fontWeight:600,color:"#c0c0c0",marginBottom:10,lineHeight:1.35}}>{r.descricao.slice(0,44)}</div>
                      <div style={{fontSize:"1.4rem",fontWeight:800,color:"#f87171",letterSpacing:"-0.02em"}}>{fmtBRL(r.valor_medio)}<span style={{fontSize:"0.68rem",color:"#404040",fontWeight:400}}>/vez</span></div>
                      <div style={{fontSize:"0.68rem",color:"#404040",marginTop:5}}>{r.count}× · Total {fmtBRL(r.total)}</div>
                    </div>
                  ))}
                </div>
                <div style={S.card}>
                  <div style={S.cT}>Todos os gastos recorrentes</div>
                  <div style={{overflowX:"auto"}}>
                    <table style={S.tbl}>
                      <thead><tr>{["Descrição","Categoria","Freq.","Valor médio","Total"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                      <tbody>
                        {recorrentes.map((r,i)=>(
                          <tr key={r.descricao} style={S.tr} className="ltr">
                            <td style={S.tdM}>{r.descricao.slice(0,54)}</td>
                            <td style={S.td}><span style={S.badge}>{categorizarTransacao(r.descricao)}</span></td>
                            <td style={S.td}>{r.count}×</td>
                            <td style={S.td}>{fmtBRL(r.valor_medio)}</td>
                            <td style={{...S.td,color:"#f87171",fontWeight:600}}>{fmtBRL(r.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            }
          </>}

          {/* ══ INSIGHTS ══ */}
          {activeTab===4&&<>
            <h1 style={S.pT}>Insights</h1>
            <p style={S.pS}>Análise inteligente do seu comportamento financeiro</p>
            <div style={{display:"flex",gap:18,alignItems:"flex-start",marginBottom:18,flexWrap:"wrap"}}>
              <div style={{...S.card,flexShrink:0,display:"flex",flexDirection:"column",alignItems:"center",gap:8,padding:"26px 22px",minWidth:190}}>
                <div style={S.cT}>Saúde financeira</div>
                <ScoreRing score={score}/>
                <div style={{fontSize:"0.74rem",color:"#505050",textAlign:"center",marginTop:4}}>
                  {score>=70?"Situação excelente":score>=40?"Situação moderada":"Atenção necessária"}
                </div>
              </div>
              <div style={{flex:1,minWidth:260}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}} className="lg2">
                  {[
                    {color:taxaPoupanca>=20?"#6ee7b7":taxaPoupanca>=10?"#facc15":"#f87171",
                     text:taxaPoupanca>=20?`✓ Você está poupando ${taxaPoupanca.toFixed(1)}% da renda. Excelente!`:taxaPoupanca>=10?`↗ Taxa de poupança: ${taxaPoupanca.toFixed(1)}%. Tente chegar a 20%.`:`↓ Taxa de poupança: ${taxaPoupanca.toFixed(1)}%. Abaixo do ideal.`},
                    {color:saldoLiquido>=0?"#6ee7b7":"#f87171",
                     text:saldoLiquido>=0?`✓ Saldo positivo de ${fmtBRL(saldoLiquido)}. Gastou menos do que recebeu.`:`⚠ Saldo negativo de ${fmtBRL(Math.abs(saldoLiquido))}. Gastos superaram as entradas.`},
                    tendencias.tendencia_gastos==="crescente"
                      ?{color:"#facc15",text:`↑ Gastos cresceram ${tendencias.variacao_percentual.toFixed(1)}% em relação à 1ª metade do período.`}
                      :tendencias.tendencia_gastos==="decrescente"
                      ?{color:"#6ee7b7",text:`↓ Gastos reduziram ${Math.abs(tendencias.variacao_percentual).toFixed(1)}% em relação à 1ª metade do período.`}
                      :{color:"#60a5fa",text:`→ Gastos estáveis. Variação de ${tendencias.variacao_percentual.toFixed(1)}% no período.`},
                    byCategoria.length?{color:"#fb923c",text:`🔍 Maior gasto: ${byCategoria[0].label} (${fmtBRL(byCategoria[0].value)}, ${byCategoria[0].pct.toFixed(1)}% do total).`}:{color:"#60a5fa",text:"Sem dados de categoria suficientes."},
                    recorrentes.length?{color:"#a78bfa",text:`🔁 ${recorrentes.length} gastos recorrentes · Total: ${fmtBRL(recorrentes.reduce((s,r)=>s+r.total,0))}.`}:{color:"#6ee7b7",text:"✓ Nenhum gasto recorrente no período."},
                    metricas.maior_gasto>metricas.gasto_medio_diario*10?{color:"#facc15",text:`⚠ Gasto atípico de ${fmtBRL(metricas.maior_gasto)} detectado. Muito acima da média diária.`}:{color:"#6ee7b7",text:`✓ Sem gastos atípicos. Maior: ${fmtBRL(metricas.maior_gasto)}.`},
                  ].map((ins,i)=>(
                    <div key={i} style={{...S.iCard,borderLeftColor:ins.color}}>
                      <p style={S.iText}>{ins.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div style={S.card}>
              <div style={S.cT}>Top 10 maiores gastos</div>
              <div style={{overflowX:"auto"}}>
                <table style={S.tbl}>
                  <thead><tr>{["Data","Descrição","Categoria","Valor"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {[...filtered].filter(r=>r.valor<0).sort((a,b)=>a.valor-b.valor).slice(0,10).map((r,i)=>(
                      <tr key={i} style={S.tr} className="ltr">
                        <td style={S.td}>{fmtDate(r.data)}</td>
                        <td style={S.tdM}>{r.descricao.slice(0,54)}</td>
                        <td style={S.td}><span style={S.badge}>{r.categoria}</span></td>
                        <td style={{...S.td,color:"#f87171",fontWeight:600}}>{fmtBRL(r.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>}

          {/* ══ TRANSAÇÕES ══ */}
          {activeTab===5&&<>
            <h1 style={S.pT}>Transações</h1>
            <p style={S.pS}>Histórico completo de movimentações</p>
            <div style={S.fRow}>
              <input placeholder="Buscar na descrição..." style={S.fSearch} value={searchTx} onChange={e=>setSearchTx(e.target.value)}/>
              <select style={S.fSel} value={sortTx} onChange={e=>setSortTx(e.target.value)}>
                <option value="data_desc">Data (mais recente)</option>
                <option value="data_asc">Data (mais antiga)</option>
                <option value="valor_desc">Valor (maior)</option>
                <option value="valor_asc">Valor (menor)</option>
              </select>
              <button style={S.dlBtn} onClick={downloadCSV}>↓ Exportar CSV</button>
            </div>
            <div style={S.card}>
              <div style={{overflowX:"auto"}}>
                <table style={S.tbl}>
                  <thead><tr>{["Data","Descrição","Categoria","Valor","Saldo"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {txDisplay.map((r,i)=>(
                      <tr key={i} style={S.tr} className="ltr">
                        <td style={S.td}>{fmtDate(r.data)}</td>
                        <td style={S.tdM}>{r.descricao.slice(0,58)}</td>
                        <td style={S.td}><span style={S.badge}>{r.categoria}</span></td>
                        <td style={{...S.td,color:r.valor<0?"#f87171":"#6ee7b7",fontWeight:600}}>{fmtBRL(r.valor)}</td>
                        <td style={S.td}>{fmtBRL(r.saldo)}</td>
                      </tr>
                    ))}
                    {!txDisplay.length&&<tr><td colSpan={5} style={{...S.td,textAlign:"center",padding:"40px",color:"#303030"}}>Nenhuma transação encontrada.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div style={{marginTop:12,fontSize:"0.68rem",color:"#303030",textAlign:"right"}}>
                Exibindo {txDisplay.length} de {filtered.length} transações
              </div>
            </div>
          </>}
        </main>
      </div>
    </div>
  );
}