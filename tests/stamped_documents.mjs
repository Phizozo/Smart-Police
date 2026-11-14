// Isolated PDF-content checks. Requires Node dependencies and Poppler's pdftotext.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {PDFDocument,degrees,StandardFonts} from 'pdf-lib';
import {mkdirSync,writeFileSync} from 'node:fs';

const source=await PDFDocument.create();
const font=await source.embedFont(StandardFonts.Helvetica);
source.addPage([595,842]).drawText('REAL COPY PAGE ONE - do not substitute the original',{x:30,y:740,font,size:12});
const rotated=source.addPage([595,842]);
rotated.drawText('REAL COPY PAGE TWO - rotated document',{x:30,y:740,font,size:12});
rotated.setRotation(degrees(90));
const pdf=Buffer.from(await source.save());
const register=await PDFDocument.create();
register.addPage().drawText('Review attachment register');
const input={
  kind:'certification',mime:'application/pdf',source:pdf.toString('base64'),register:Buffer.from(await register.save()).toString('base64'),
  ref:'SP-TEST-0001',name:'Simphiwe Skosana',role:'officer',signature:'S Skosana',
  at:'2026-11-03T12:30:00+02:00',datetime:'2026-11-03 12:30:00 SAST (+02:00)',sourceSha:'a'.repeat(64)
};
function stamp(values) {
  return spawnSync('node',['scripts/stamp-request.mjs'],{input:JSON.stringify(values),maxBuffer:45*1024*1024,timeout:30000});
}
const result=stamp(input);
assert.equal(result.status,0,result.stderr.toString());
const text=spawnSync('pdftotext',['-layout','-','-'],{input:result.stdout,maxBuffer:10*1024*1024});
assert.equal(text.status,0,text.stderr.toString());
for (const phrase of ['REAL COPY PAGE ONE','REAL COPY PAGE TWO','S Skosana','Simphiwe Skosana','2026-11-03 12:30:00','Review attachment register']) assert(text.stdout.includes(phrase),phrase);
assert.equal((text.stdout.toString().match(/DIGITAL APPROVAL STAMP/g)||[]).length,2);
const output=await PDFDocument.load(result.stdout);
assert.equal(output.getPageCount(),3);
assert(output.getPage(1).getWidth()>output.getPage(1).getHeight(),'Rotated page should have a landscape appearance with space below for its stamp');
const bad=stamp({...input,source:Buffer.from('%PDF-1.4\ninvalid').toString('base64')});
assert.equal(bad.status,2);
assert.equal(bad.stdout.length,0,'A malformed file must not produce a substitute approval PDF');
const image=stamp({...input,mime:'image/png',source:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII='});
assert.equal(image.status,0,image.stderr.toString());
const formPdf=await PDFDocument.create(), formPage=formPdf.addPage();
const field=formPdf.getForm().createTextField('submitted-value');
field.addToPage(formPage,{x:30,y:600,width:300,height:40});
field.setText('VISIBLE FILLED FORM VALUE');
const formResult=stamp({...input,source:Buffer.from(await formPdf.save()).toString('base64')});
assert.equal(formResult.status,0,formResult.stderr.toString());
assert(spawnSync('pdftotext',['-','-'],{input:formResult.stdout}).stdout.includes('VISIBLE FILLED FORM VALUE'),'Visible form values must survive stamping');
const initial=spawnSync('php',['-r','require "src/request-stamp.php"; echo request_signature("Simphiwe Skosana");']);
assert.equal(initial.stdout.toString(),'S Skosana');
mkdirSync('generated-artifacts/stamped-documents',{recursive:true});
writeFileSync('generated-artifacts/stamped-documents/approved-copy.pdf',result.stdout);
writeFileSync('generated-artifacts/stamped-documents/approved-image.pdf',image.stdout);
console.log('PASS: actual multi-page copy, rotated page, PNG copy, signature, approval date/time, source register and malformed-PDF failure');
