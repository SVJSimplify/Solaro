/* Turns an uploaded file into the plain-text setup format that importer.js reads.
   .txt  : used as-is
   .csv / .tsv : cells joined with " | "
   .xlsx / Google Sheets export : each sheet becomes a section; a sheet named
                 "Doctors" or "Answers" sets the section, rows become lines
   .pdf  : text lines; columns split where the layout has a wide gap (best effort) */
import readXlsxFile from 'read-excel-file/browser';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;

const rowLine=cells=>{
  const c=cells.map(x=>String(x??'').replace(/\s*\n\s*/g,' ').trim());
  while(c.length&&c.at(-1)==='')c.pop();
  return c.join(' | ');
};

/* RFC-4180-style CSV: quoted cells, commas inside quotes, doubled quotes. */
export function csvRows(text,delim=','){
  const rows=[];let row=[],cell='',q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(q){
      if(ch==='"'&&text[i+1]==='"'){cell+='"';i++}
      else if(ch==='"')q=false;
      else cell+=ch;
    }else if(ch==='"')q=true;
    else if(ch===delim){row.push(cell);cell=''}
    else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell=''}
    else cell+=ch;
  }
  if(cell||row.length){row.push(cell);rows.push(row)}
  return rows;
}

const sectionFor=name=>{
  const n=name.toLowerCase();
  if(/doctor|staff|schedule/.test(n))return'[doctors]';
  if(/answer|knowledge|faq|info/.test(n))return'[answers]';
  return null;
};

const cellText=v=>v instanceof Date?v.toISOString().slice(0,10):v;
function sheetsToText(sheets){
  const out=[];
  for(const {sheet,data} of sheets){
    const sec=sectionFor(sheet);
    if(sec)out.push(sec);
    for(const r of data){const line=rowLine(r.map(cellText));if(line)out.push(line)}
  }
  return out.join('\n');
}

async function pdfToText(buf){
  const doc=await pdfjs.getDocument({data:buf,isEvalSupported:false}).promise;
  const lines=[];
  for(let p=1;p<=doc.numPages;p++){
    const page=await (await doc).getPage(p);
    const {items}=await page.getTextContent();
    const rows=new Map();
    for(const it of items){
      if(!it.str?.trim())continue;
      const y=Math.round(it.transform[5]);
      if(!rows.has(y))rows.set(y,[]);
      rows.get(y).push({x:it.transform[4],s:it.str,w:it.width||0});
    }
    for(const y of [...rows.keys()].sort((a,b)=>b-a)){
      const cells=rows.get(y).sort((a,b)=>a.x-b.x);
      let line='',prevEnd=null;
      for(const c of cells){
        if(prevEnd!==null&&c.x-prevEnd>25)line+=' | ';
        else if(prevEnd!==null)line+=' ';
        line+=c.s;prevEnd=c.x+c.w;
      }
      lines.push(line.trim());
    }
  }
  return lines.join('\n');
}

export async function readSetupFile(file){
  const name=file.name.toLowerCase();
  if(file.size>10*1024*1024)throw Error('That file is over 10 MB. Split it or save only the sheets you need.');
  if(name.endsWith('.xls'))throw Error('Save it as .xlsx (Excel: File → Save As → Excel Workbook) and upload that.');
  if(name.endsWith('.xlsx'))return sheetsToText(await readXlsxFile(file));
  if(name.endsWith('.pdf')){
    return pdfToText(new Uint8Array(await file.arrayBuffer()));
  }
  const text=await file.text();
  if(name.endsWith('.csv')||name.endsWith('.tsv')){
    const delim=name.endsWith('.tsv')?'\t':',';
    return csvRows(text,delim).map(rowLine).filter(Boolean).join('\n');
  }
  return text;
}
