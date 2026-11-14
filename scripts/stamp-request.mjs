// Server-side PDF creation. Document bytes travel over private pipes, not public files.
import {PDFDocument, rgb, degrees} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {readFile} from 'node:fs/promises';

try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('Request too large');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!['affidavit','certification'].includes(input.kind) || !['officer','admin'].includes(input.role)) throw new Error('Invalid approval');
  const output = await PDFDocument.create();
  output.registerFontkit(fontkit);
  const font = await output.embedFont(await readFile(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)), {subset:true});
  const bold = await output.embedFont(await readFile(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf', import.meta.url)), {subset:true});
  const signatureFont = await output.embedFont(await readFile(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf', import.meta.url)), {subset:true});
  const stamp = (page, number, total) => {
    const width = page.getWidth(), margin = 20;
    page.drawRectangle({x:margin,y:36,width:width-margin*2,height:96,borderWidth:1.4,borderColor:rgb(.15,.15,.15),color:rgb(.96,.96,.96)});
    const line = (text, y, preferred=9, face=font) => {
      const fontSize = Math.min(preferred, (width-margin*2-20)/Math.max(face.widthOfTextAtSize(text,1),1));
      page.drawText(text,{x:margin+10,y,size:fontSize,font:face,color:rgb(0,0,0)});
    };
    line('SMART POLICE | DIGITAL APPROVAL STAMP',116,11,bold);
    line(`${input.ref} | Approved by ${input.name} (${input.role}) | Page ${number} of ${total}`,101,8);
    line(`Electronic signature: ${input.signature}`,84,12,signatureFont);
    line(`Date and time: ${input.datetime}`,66,9,bold);
    line(`Source SHA-256: ${input.sourceSha}`,49,6.5);
    page.drawText('Electronic approval record, not a cryptographic digital signature. Present originals where legally required.',{x:margin,y:18,size:6,font,color:rgb(0,0,0)});
  };
  const source = Buffer.from(input.source,'base64');
  if (!source.length || source.length > 20*1024*1024) throw new Error('Invalid source');
  if (input.mime === 'application/pdf') {
    const pdf = await PDFDocument.load(source,{ignoreEncryption:false});
    if (pdf.getPageCount() < 1 || pdf.getPageCount() > 200) throw new Error('Unsupported page count');
    const form = pdf.getForm();
    if (form.hasXFA()) throw new Error('Dynamic forms need a flattened copy');
    if (form.getFields().length) form.flatten();
    for (const [index, original] of pdf.getPages().entries()) {
      if (original.node.Annots()?.asArray().some(ref=>pdf.context.lookup(ref))) throw new Error('Flatten visible annotations before stamping');
      const crop = original.getCropBox();
      if (![crop.width,crop.height].every(n=>Number.isFinite(n)&&n>0&&n<=14400)) throw new Error('Unsupported page dimensions');
      const angle = ((original.getRotation().angle%360)+360)%360;
      if (![0,90,180,270].includes(angle)) throw new Error('Unsupported rotation');
      const displayWidth = angle%180 ? crop.height : crop.width;
      const displayHeight = angle%180 ? crop.width : crop.height;
      const width = Math.max(595,displayWidth), height = Math.max(300,displayHeight+156);
      const page = output.addPage([width,height]);
      const embedded = await output.embedPage(original,{left:crop.x,bottom:crop.y,right:crop.x+crop.width,top:crop.y+crop.height});
      let x=(width-displayWidth)/2, y=156+(height-156-displayHeight)/2;
      if (angle===90) y+=crop.width;
      if (angle===180) {x+=crop.width;y+=crop.height;}
      if (angle===270) x+=crop.height;
      page.drawPage(embedded,{x,y,width:crop.width,height:crop.height,rotate:degrees(-angle)});
      stamp(page,index+1,pdf.getPageCount());
    }
  } else if (['image/png','image/jpeg'].includes(input.mime)) {
    const image = input.mime==='image/png' ? await output.embedPng(source) : await output.embedJpg(source);
    if (image.width*image.height>40000000) throw new Error('Image too large');
    const page = output.addPage([595,842]), scale=Math.min(547/image.width,662/image.height);
    page.drawImage(image,{x:(595-image.width*scale)/2,y:156+(662-image.height*scale)/2,width:image.width*scale,height:image.height*scale});
    stamp(page,1,1);
  } else throw new Error('Unsupported copy');
  // Certification PDFs include the submitted copy itself, followed by its review register.
  if (input.kind==='certification') {
    const register=await PDFDocument.load(Buffer.from(input.register,'base64'));
    for (const page of await output.copyPages(register,register.getPageIndices())) output.addPage(page);
  }
  output.setTitle(input.kind==='affidavit'?'Affidavit Report':'Approved stamped document copy');
  output.setAuthor(input.name);
  output.setSubject(`${input.ref} | Electronic signature: ${input.signature} | ${input.datetime}`);
  output.setCreationDate(new Date(input.at));
  output.setModificationDate(new Date(input.at));
  const bytes=await output.save({useObjectStreams:false});
  if (bytes.length>40*1024*1024) throw new Error('Output too large');
  process.stdout.write(Buffer.from(bytes));
} catch {
  process.stderr.write('The document could not be stamped. Use a readable, flattened, unencrypted PDF of up to 200 pages, or a PNG/JPEG copy under 40 megapixels.');
  process.exitCode=2;
}
