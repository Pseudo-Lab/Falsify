/* RED visual editor. No build step.
   Root mounts this host, links paper-visual-edit.css, and calls refresh when the
   source PDF changes. This file does not edit the airport shell or start BLUE.
   PDF bytes change only after "PDF에 적용". onOutput receives the verified export
   and the same payload again from "이 PDF로 BLUE 검토". */
(function(root){
  'use strict';
  const PREPARE='/api/paper/evidence/prepare';
  const QUERY='/api/paper/evidence/query';
  const EXPORT='/api/paper/visual/export';
  const REQUEST_SCHEMA='falsify.visual-edit-request.v1';
  const EXPORT_SCHEMA='falsify.visual-edit-export.v1';
  const EVIDENCE_SCHEMA='falsify.paper-evidence.v1';
  const HEX=/^[0-9a-f]{64}$/;
  const MAX_PDF=25*1024*1024;
  const MAX_IMAGE=4*1024*1024;
  const MAX_PIXELS=4000000;
  const LIST_PAGE=8;
  const ROW_PAGE=10;
  const MAX_OPS=24;
  const MAX_POINTS=2000;
  const TEXT={
    need:'PDF를 선택하세요.',
    preparing:'표와 그림을 읽고 있습니다.',
    hash:'원본 파일이 바뀌어 열지 않았습니다.',
    notPdf:'PDF가 아니라 열지 않았습니다.',
    limit:'25 MiB를 넘는 PDF는 열지 않습니다.',
    unavailable:'PC 연결 후 다시 시도하세요.',
    failed:'불러오지 못했습니다.',
    expired:'준비한 표·그림이 만료되었습니다. 다시 불러오세요.',
    busy:'다른 작업이 끝난 뒤 적용하세요.',
    listFailed:'목록을 불러오지 못했습니다.',
    previewFailed:'미리보기를 만들지 못했습니다.',
    previewMissing:'시각 미리보기가 없습니다.',
    chartMissing:'그래프 그리기 모듈이 없습니다.',
    chartBad:'그래프 형식을 읽지 못했습니다.',
    chartInvalid:'점과 축 눈금을 확인하세요. 로그 눈금은 0보다 큰 수만 그립니다.',
    plotFailed:'그래프를 다시 그리지 못했습니다. 마지막 PDF는 그대로입니다.',
    applyNone:'바꾼 내용이 없습니다.',
    applyMax:'한 번에 24곳까지 적용할 수 있습니다.',
    applyFail:'PDF에 적용하지 못했습니다. 마지막 결과는 그대로입니다.',
    applyOk:'PDF에 적용했습니다.',
    stale:'원본이 바뀌어 이번 적용은 반영하지 않았습니다.',
    hold:'적용이 보류되었습니다.',
    handoff:'PDF는 만들어졌습니다. 검토 화면으로 넘기지 못했습니다.',
    jpeg:'이 JPEG를 PNG로 바꾸지 못했습니다.',
    image:'PNG 또는 JPEG를 선택하세요.',
    imageLimit:'이미지가 너무 큽니다.',
    crop:'자르기 범위를 확인하세요.',
    labelNeed:'라벨을 입력한 뒤 놓기를 누르세요.',
    labelPlace:'미리보기에서 라벨 위치를 누르세요.',
    labelMiss:'선택한 영역 안을 누르세요.',
    labelFont:'이 화면에서는 영문, 숫자, 기본 기호 라벨만 그릴 수 있습니다.',
    ocrBox:'쪽 좌표가 없는 스캔 셀은 바꾸지 않습니다.',
    region:'영역을 그리지 못했습니다.',
    retry:'다시 불러오기',
    empty:'표시할 항목이 없습니다.',
    note:'낮은값과 높은값은 입력한 경우에만 넣습니다. 측정값이나 구간으로 바꾸지 않습니다.'
  };
  const CODES={
    paper_evidence_request_invalid:'failed',
    paper_evidence_hash_invalid:'hash',
    paper_evidence_file_limit:'limit',
    paper_evidence_file_invalid:'notPdf',
    paper_evidence_operation_invalid:'failed',
    paper_evidence_id_invalid:'failed',
    paper_evidence_expired_or_missing:'expired',
    companion_busy:'busy',
    visual_input_invalid:'hash',
    visual_file_hash_mismatch:'hash',
    visual_not_pdf:'notPdf',
    visual_selection_invalid:'previewFailed'
  };
  const ZIGZAG=[
    0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,
    35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63
  ];
  const COS=new Float64Array(64);
  for(let u=0;u<8;u++)for(let x=0;x<8;x++)COS[u*8+x]=Math.cos(((2*x+1)*u*Math.PI)/16);
  const CRC_TABLE=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);table[n]=c>>>0;}return table;})();
  const FONT={
    ' ':[0,0,0,0,0,0,0],'?':[14,17,1,2,4,0,4],'-':[0,0,0,31,0,0,0],'.':[0,0,0,0,0,12,12],'+':[0,4,4,31,4,4,0],'%':[19,19,2,4,8,25,25],
    '0':[14,17,19,21,25,17,14],'1':[4,12,4,4,4,4,14],'2':[14,17,1,2,4,8,31],'3':[14,17,1,6,1,17,14],'4':[2,6,10,18,31,2,2],
    '5':[31,16,30,1,1,17,14],'6':[6,8,16,30,17,17,14],'7':[31,1,2,4,8,8,8],'8':[14,17,17,14,17,17,14],'9':[14,17,17,15,1,2,12],
    'A':[14,17,17,31,17,17,17],'B':[30,17,17,30,17,17,30],'C':[14,17,16,16,16,17,14],'D':[30,17,17,17,17,17,30],'E':[31,16,16,30,16,16,31],
    'F':[31,16,16,30,16,16,16],'G':[14,17,16,23,17,17,14],'H':[17,17,17,31,17,17,17],'I':[14,4,4,4,4,4,14],'J':[7,2,2,2,2,18,12],
    'K':[17,18,20,24,20,18,17],'L':[16,16,16,16,16,16,31],'M':[17,27,21,21,17,17,17],'N':[17,25,21,19,17,17,17],'O':[14,17,17,17,17,17,14],
    'P':[30,17,17,30,16,16,16],'Q':[14,17,17,17,21,18,13],'R':[30,17,17,30,20,18,17],'S':[14,17,16,14,1,17,14],'T':[31,4,4,4,4,4,4],
    'U':[17,17,17,17,17,17,14],'V':[17,17,17,17,17,10,4],'W':[17,17,17,21,21,21,10],'X':[17,17,10,4,10,17,17],'Y':[17,17,10,4,4,4,4],'Z':[31,1,2,4,8,16,31]
  };
  let instances=0;

  function err(code){const error=new Error(code);error.code=code;return error;}
  function finite(n){return typeof n==='number'&&Number.isFinite(n);}
  function bboxOk(b){return Array.isArray(b)&&b.length===4&&b.every(finite)&&b.every(n=>Math.abs(n)<=20000)&&b[2]>b[0]&&b[3]>b[1];}
  function closeBox(a,b){return bboxOk(a)&&bboxOk(b)&&a.every((n,i)=>Math.abs(n-b[i])<=0.05);}
  function clip(value,max){const text=String(value==null?'':value).replace(/[\u0000-\u001f]/g,'');return text.length>max?text.slice(0,max)+'…':text;}
  function paperIdOk(id){return typeof id==='string'&&id.length>=1&&id.length<=160&&!/[\u0000-\u0020\u007f]/.test(id);}
  function idOk(id){return typeof id==='string'&&id.length>=1&&id.length<=160&&!/[\u0000-\u001f]/.test(id);}
  function countOk(n){return Number.isSafeInteger(n)&&n>=0&&n<=100000;}
  function roundPt(n){return Math.round(n*100)/100;}
  function round4(n){return Math.round(n*10000)/10000;}
  function codeOf(error){
    if(error&&typeof error.code==='string'&&TEXT[error.code])return error.code;
    if(error&&typeof error.code==='string'&&CODES[error.code])return CODES[error.code];
    const msg=error&&typeof error.message==='string'?error.message:'';
    if(CODES[msg])return CODES[msg];
    if(TEXT[msg])return msg;
    if(error&&(error.httpStatus===401||error.httpStatus===403))return 'unavailable';
    return 'failed';
  }
  function crc32(bytes){let c=0xFFFFFFFF;for(let i=0;i<bytes.length;i++)c=CRC_TABLE[(c^bytes[i])&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
  function readU32(bytes,offset){return ((bytes[offset]<<24)|(bytes[offset+1]<<16)|(bytes[offset+2]<<8)|bytes[offset+3])>>>0;}
  function concat(parts){let n=0;for(const part of parts)n+=part.length;const out=new Uint8Array(n);let o=0;for(const part of parts){out.set(part,o);o+=part.length;}return out;}
  function isPng(bytes){return bytes&&bytes.length>=8&&bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71&&bytes[4]===13&&bytes[5]===10&&bytes[6]===26&&bytes[7]===10;}
  function isJpeg(bytes){return bytes&&bytes.length>=3&&bytes[0]===0xFF&&bytes[1]===0xD8&&bytes[2]===0xFF;}
  function isPdf(bytes){return bytes&&bytes.length>=5&&bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&bytes[3]===0x46&&bytes[4]===0x2D;}
  async function inflateZlib(bytes){
    if(typeof root.DecompressionStream!=='function')throw err('png');
    const stream=new root.Blob([bytes]).stream().pipeThrough(new root.DecompressionStream('deflate'));
    return new Uint8Array(await new root.Response(stream).arrayBuffer());
  }
  async function deflateZlib(bytes){
    if(typeof root.CompressionStream!=='function')return zlibStore(bytes);
    const stream=new root.Blob([bytes]).stream().pipeThrough(new root.CompressionStream('deflate'));
    return new Uint8Array(await new root.Response(stream).arrayBuffer());
  }
  function adler32(data){let a=1,b=0;for(let i=0;i<data.length;i++){a=(a+data[i])%65521;b=(b+a)%65521;}return ((b<<16)|a)>>>0;}
  function zlibStore(data){
    const parts=[Uint8Array.of(0x78,0x01)];
    let i=0;
    do{
      const n=Math.min(65535,data.length-i);
      const block=new Uint8Array(5+n);
      block[0]=i+n>=data.length?1:0;
      block[1]=n&255;block[2]=(n>>8)&255;block[3]=block[1]^255;block[4]=block[2]^255;
      block.set(data.subarray(i,i+n),5);
      parts.push(block);
      i+=n;
    }while(i<data.length);
    const tail=new Uint8Array(4);
    new DataView(tail.buffer).setUint32(0,adler32(data));
    parts.push(tail);
    return concat(parts);
  }
  async function encodePng(image){
    const {width,height,rgba}=image;
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>MAX_PIXELS)throw err('png');
    if(!rgba||rgba.length!==width*height*4)throw err('png');
    const stride=width*4;
    const raw=new Uint8Array(height*(stride+1));
    for(let y=0;y<height;y++){raw[y*(stride+1)]=0;raw.set(rgba.subarray(y*stride,(y+1)*stride),y*(stride+1)+1);}
    const ihdr=new Uint8Array(13);
    const view=new DataView(ihdr.buffer);
    view.setUint32(0,width);view.setUint32(4,height);
    ihdr[8]=8;ihdr[9]=6;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
    const zipped=await deflateZlib(raw);
    return concat([
      Uint8Array.of(137,80,78,71,13,10,26,10),
      chunk('IHDR',ihdr),
      chunk('IDAT',zipped),
      chunk('IEND',new Uint8Array())
    ]);
  }
  function chunk(type,data){
    const out=new Uint8Array(12+data.length);
    const view=new DataView(out.buffer);
    view.setUint32(0,data.length);
    out[4]=type.charCodeAt(0);out[5]=type.charCodeAt(1);out[6]=type.charCodeAt(2);out[7]=type.charCodeAt(3);
    out.set(data,8);
    view.setUint32(8+data.length,crc32(out.subarray(4,8+data.length)));
    return out;
  }
  async function decodeNative(bytes){
    if(isPng(bytes)){
      if(bytes.length<24||readU32(bytes,16)*readU32(bytes,20)>MAX_PIXELS)throw err('png');
    }else if(isJpeg(bytes)){
      let pos=2;
      while(pos+4<bytes.length){
        if(bytes[pos++]!==255)continue;
        const marker=bytes[pos++];if(marker===216||marker===217)continue;
        const n=(bytes[pos]<<8)|bytes[pos+1];if(n<2||pos+n>bytes.length)throw err('jpeg');
        if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
          const h=(bytes[pos+3]<<8)|bytes[pos+4],w=(bytes[pos+5]<<8)|bytes[pos+6];if(!w||!h||w*h>MAX_PIXELS)throw err('jpeg');break;
        }pos+=n;
      }
    }
    const bitmap=await root.createImageBitmap(new root.Blob([bytes],{type:isPng(bytes)?'image/png':'image/jpeg'}));
    const canvas=root.document.createElement('canvas');
    try{
      if(bitmap.width*bitmap.height>MAX_PIXELS)throw err('imageLimit');
      canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);
      return {width:canvas.width,height:canvas.height,rgba:new Uint8Array(ctx.getImageData(0,0,canvas.width,canvas.height).data)};
    }finally{bitmap.close?.();canvas.width=canvas.height=0;}
  }
  async function decodePng(bytes){
    if(typeof root.createImageBitmap==='function'&&root.document)return decodeNative(bytes);
    if(!isPng(bytes))throw err('png');
    let offset=8,width=0,height=0,color=0,depth=0,interlace=1,header=false,end=false;
    const idat=[];
    while(offset+8<=bytes.length){
      const length=readU32(bytes,offset);
      if(offset+12+length>bytes.length)throw err('png');
      const type=String.fromCharCode(bytes[offset+4],bytes[offset+5],bytes[offset+6],bytes[offset+7]);
      const data=bytes.subarray(offset+8,offset+8+length);
      const crc=readU32(bytes,offset+8+length);
      if(crc!==crc32(bytes.subarray(offset+4,offset+8+length)))throw err('png');
      offset+=12+length;
      if(type==='IHDR'){
        if(data.length!==13)throw err('png');
        width=readU32(data,0);height=readU32(data,4);depth=data[8];color=data[9];interlace=data[12];
        if(data[10]!==0||data[11]!==0)throw err('png');
        header=true;
      }else if(type==='IDAT')idat.push(data);
      else if(type==='IEND'){end=true;break;}
    }
    if(!header||!end||depth!==8||interlace!==0||width<1||height<1||width*height>MAX_PIXELS)throw err('png');
    const channels=color===0?1:color===2?3:color===4?2:color===6?4:0;
    if(!channels)throw err('png');
    const raw=await inflateZlib(concat(idat));
    const stride=width*channels;
    if(raw.length!==height*(stride+1))throw err('png');
    const out=new Uint8Array(width*height*4);
    const prev=new Uint8Array(stride);
    const cur=new Uint8Array(stride);
    for(let y=0;y<height;y++){
      const filter=raw[y*(stride+1)];
      const row=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1));
      for(let i=0;i<stride;i++){
        const left=i>=channels?cur[i-channels]:0;
        const up=prev[i];
        const ul=i>=channels?prev[i-channels]:0;
        let value=row[i];
        if(filter===1)value=(value+left)&255;
        else if(filter===2)value=(value+up)&255;
        else if(filter===3)value=(value+Math.floor((left+up)/2))&255;
        else if(filter===4)value=(value+paeth(left,up,ul))&255;
        else if(filter!==0)throw err('png');
        cur[i]=value;
      }
      prev.set(cur);
      for(let x=0;x<width;x++){
        const s=x*channels,d=(y*width+x)*4;
        if(channels===1)out.set([cur[s],cur[s],cur[s],255],d);
        else if(channels===2)out.set([cur[s],cur[s],cur[s],cur[s+1]],d);
        else if(channels===3)out.set([cur[s],cur[s+1],cur[s+2],255],d);
        else out.set([cur[s],cur[s+1],cur[s+2],cur[s+3]],d);
      }
    }
    return {width,height,rgba:out};
  }
  function paeth(a,b,c){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
  function cropRgba(image,crop){
    const x=crop.x,y=crop.y,w=crop.w,h=crop.h;
    if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||!Number.isSafeInteger(w)||!Number.isSafeInteger(h))return null;
    if(w<1||h<1||x<0||y<0||x+w>image.width||y+h>image.height)return null;
    const rgba=new Uint8Array(w*h*4);
    for(let row=0;row<h;row++)rgba.set(image.rgba.subarray(((y+row)*image.width+x)*4,((y+row)*image.width+x+w)*4),row*w*4);
    return {width:w,height:h,rgba};
  }
  function glyphOf(ch){return FONT[ch]||FONT[String(ch).toUpperCase()]||FONT['?'];}
  function blitText(image,text,x0,y0,backing){
    const scale=2,gap=2;
    let x=Math.round(x0),y=Math.round(y0);
    for(const ch of text){
      const glyph=glyphOf(ch);
      if(backing)fillRect(image,x-1,y-1,5*scale+2,7*scale+2,[255,255,255,255]);
      for(let row=0;row<7;row++)for(let col=0;col<5;col++)if(glyph[row]&(1<<(4-col)))fillRect(image,x+col*scale,y+row*scale,scale,scale,[17,19,21,255]);
      x+=5*scale+gap;
    }
  }
  function fillRect(image,x,y,w,h,color){
    const x0=Math.max(0,x),y0=Math.max(0,y),x1=Math.min(image.width,x+w),y1=Math.min(image.height,y+h);
    for(let py=y0;py<y1;py++)for(let px=x0;px<x1;px++)image.rgba.set(color,(py*image.width+px)*4);
  }
  function fillAll(image,color){for(let i=0;i<image.rgba.length;i+=4)image.rgba.set(color,i);}
  async function canvasLabel(image,text,at,mode,doc){
    if(!doc||typeof doc.createElement!=='function'||typeof root.ImageData!=='function')return null;
    let canvas,ctx;
    try{canvas=doc.createElement('canvas');ctx=canvas&&canvas.getContext&&canvas.getContext('2d');}catch{return null;}
    if(!ctx||typeof ctx.putImageData!=='function'||typeof ctx.fillText!=='function')return null;
    const blobber=canvas.convertToBlob||canvas.toBlob;
    if(typeof blobber!=='function')return null;
    canvas.width=image.width;canvas.height=image.height;
    try{
      ctx.putImageData(new root.ImageData(new Uint8ClampedArray(image.rgba),image.width,image.height),0,0);
      ctx.font='16px sans-serif';
      const width=Math.max(8,Math.ceil(ctx.measureText?ctx.measureText(text).width:text.length*9));
      if(mode==='cell'){ctx.fillStyle='#ffffff';ctx.fillRect(0,0,image.width,image.height);}
      else{ctx.fillStyle='#ffffff';ctx.fillRect(at.x,at.y,width+8,20);}
      ctx.fillStyle='#111315';
      ctx.fillText(text,at.x+2,at.y+16);
      const blob=await new Promise(resolve=>blobber.call(canvas,resolve,'image/png'));
      if(!blob||typeof blob.arrayBuffer!=='function')return null;
      const png=new Uint8Array(await blob.arrayBuffer());
      return isPng(png)?png:null;
    }catch{return null;}
  }
  async function rasterText(image,text,at,mode,doc){
    const via=await canvasLabel(image,text,at,mode,doc);
    if(via)return via;
    if([...text].some(ch=>ch.codePointAt(0)>126))throw err('label-font');
    const copy={width:image.width,height:image.height,rgba:image.rgba.slice()};
    if(mode==='cell')fillAll(copy,[255,255,255,255]);
    blitText(copy,text,at.x,at.y,mode==='label');
    return encodePng(copy);
  }
  function extendBits(raw,length){if(!length)return 0;const vt=1<<(length-1);return raw<vt?raw-(1<<length)+1:raw;}
  function buildHuff(counts,symbols){
    const map=new Map();
    let code=0,index=0;
    for(let length=1;length<=16;length++){
      for(let i=0;i<counts[length-1];i++){
        if(index>=symbols.length||map.has(length+':'+code))throw err('jpeg');
        map.set(length+':'+code,symbols[index++]);
        code++;
      }
      code<<=1;
    }
    if(index!==symbols.length)throw err('jpeg');
    return map;
  }
  function BitReader(bytes,offset){this.bytes=bytes;this.pos=offset;this.bit=0;this.cur=0;this.marker=-1;}
  BitReader.prototype.nextByte=function(){
    if(this.pos>=this.bytes.length)return -1;
    const value=this.bytes[this.pos++];
    if(value!==0xFF)return value;
    if(this.pos>=this.bytes.length)return -1;
    let next=this.bytes[this.pos++];
    while(next===0xFF&&this.pos<this.bytes.length)next=this.bytes[this.pos++];
    if(next===0x00)return 0xFF;
    this.marker=next;
    return -2;
  };
  BitReader.prototype.bits=function(n){
    let value=0;
    for(let i=0;i<n;i++){
      if(this.bit===0){
        const next=this.nextByte();
        if(next<0)return -1;
        this.cur=next;this.bit=8;
      }
      this.bit--;
      value=(value<<1)|((this.cur>>this.bit)&1);
    }
    return value;
  };
  BitReader.prototype.huff=function(table){
    let code=0;
    for(let length=1;length<=16;length++){
      const bit=this.bits(1);
      if(bit<0)return -1;
      code=(code<<1)|bit;
      if(table.has(length+':'+code))return table.get(length+':'+code);
    }
    return -1;
  };
  function idct(coeff){
    const out=new Float64Array(64);
    for(let y=0;y<8;y++)for(let x=0;x<8;x++){
      let sum=0;
      for(let v=0;v<8;v++)for(let u=0;u<8;u++){
        const cu=u===0?0.7071067811865476:1;
        const cv=v===0?0.7071067811865476:1;
        sum+=cu*cv*coeff[v*8+u]*COS[u*8+x]*COS[v*8+y];
      }
      out[y*8+x]=sum/4+128;
    }
    return out;
  }
  function decodeBlock(reader,dcTable,acTable,quant,pred){
    const coeff=new Float64Array(64);
    const size=reader.huff(dcTable);
    if(size<0||size>11)throw err('jpeg');
    let diff=0;
    if(size){const raw=reader.bits(size);if(raw<0)throw err('jpeg');diff=extendBits(raw,size);}
    const dc=pred+diff;
    coeff[0]=dc*quant[0];
    let k=1;
    while(k<64){
      const rs=reader.huff(acTable);
      if(rs<0)throw err('jpeg');
      if(rs===0)break;
      if(rs===0xF0){if(k+16>64)throw err('jpeg');k+=16;continue;}
      const run=rs>>4,bits=rs&15;
      k+=run;
      if(!bits||k>63)throw err('jpeg');
      const raw=reader.bits(bits);
      if(raw<0)throw err('jpeg');
      coeff[ZIGZAG[k]]=extendBits(raw,bits)*quant[ZIGZAG[k]];
      k++;
    }
    return {sample:idct(coeff),dc};
  }
  function sampleBlock(blocks,h,px,py,maxH,maxV){
    const sx=Math.min(h*8-1,Math.floor(px*h/maxH));
    const sy=Math.min(blocks.v*8-1,Math.floor(py*blocks.v/maxV));
    const block=blocks.data[(sy>>3)*h+(sx>>3)];
    return block[(sy&7)*8+(sx&7)];
  }
  async function decodeJpeg(bytes){
    if(typeof root.createImageBitmap==='function'&&root.document)return decodeNative(bytes);
    if(!isJpeg(bytes))throw err('jpeg');
    let offset=2;
    const quant=[null,null,null,null];
    const huff={dc:[null,null,null,null],ac:[null,null,null,null]};
    let frame=null,restart=0;
    const marker=()=>{if(bytes[offset]!==0xFF)throw err('jpeg');while(bytes[offset]===0xFF)offset++;return bytes[offset-1]===0xFF?bytes[offset++]:(offset++,bytes[offset-1]);};
    while(offset<bytes.length){
      if(bytes[offset]!==0xFF)throw err('jpeg');
      while(bytes[offset]===0xFF)offset++;
      const mark=bytes[offset++];
      if(mark===0xD9)break;
      if(mark===0xDA){
        const length=readU16();
        const start=offset;
        const count=bytes[offset++];
        const scan=[];
        for(let i=0;i<count;i++){const id=bytes[offset++],table=bytes[offset++];scan.push({id,dc:table>>4,ac:table&15});}
        const ss=bytes[offset++],se=bytes[offset++],ah=bytes[offset++];
        if(ss!==0||se!==63||ah!==0||offset!==start+length-2)throw err('jpeg');
        return decodeScan(bytes,offset,frame,quant,huff,scan,restart);
      }
      const length=readU16();
      const end=offset+length-2;
      if(end>bytes.length)throw err('jpeg');
      if(mark===0xC0){
        const precision=bytes[offset++],height=readU16(),width=readU16(),count=bytes[offset++];
        if(precision!==8||width<1||height<1||width*height>MAX_PIXELS||(count!==1&&count!==3))throw err('jpeg');
        const comps=[];let maxH=1,maxV=1;
        for(let i=0;i<count;i++){
          const id=bytes[offset++],hv=bytes[offset++],q=bytes[offset++];
          const h=hv>>4,v=hv&15;
          if(h<1||h>4||v<1||v>4||q>3)throw err('jpeg');
          maxH=Math.max(maxH,h);maxV=Math.max(maxV,v);
          comps.push({id,h,v,q});
        }
        frame={width,height,comps,maxH,maxV};
      }else if(mark===0xC2||mark===0xC1||mark===0xC3)throw err('jpeg');
      else if(mark===0xDB){
        while(offset<end){
          const id=bytes[offset++];
          if((id>>4)!==0||(id&15)>3)throw err('jpeg');
          const table=new Float64Array(64);
          for(let i=0;i<64;i++)table[ZIGZAG[i]]=bytes[offset++];
          quant[id&15]=table;
        }
      }else if(mark===0xC4){
        while(offset<end){
          const id=bytes[offset++];
          const counts=[];let total=0;
          for(let i=0;i<16;i++){counts.push(bytes[offset++]);total+=counts[i];}
          const symbols=[];
          for(let i=0;i<total;i++)symbols.push(bytes[offset++]);
          const table=buildHuff(counts,symbols);
          ((id>>4)?huff.ac:huff.dc)[id&15]=table;
        }
      }else if(mark===0xDD)restart=(bytes[offset]<<8)|bytes[offset+1];
      offset=end;
    }
    throw err('jpeg');
    function readU16(){const value=(bytes[offset]<<8)|bytes[offset+1];offset+=2;return value;}
  }
  function decodeScan(bytes,offset,frame,quant,huff,scan,restart){
    if(!frame)throw err('jpeg');
    const byId=new Map(frame.comps.map(comp=>[comp.id,comp]));
    const reader=new BitReader(bytes,offset);
    const pred=new Map();
    const mcuW=8*frame.maxH,mcuH=8*frame.maxV;
    const mcusX=Math.ceil(frame.width/mcuW),mcusY=Math.ceil(frame.height/mcuH);
    const rgba=new Uint8Array(frame.width*frame.height*4);
    let index=0,rst=0;
    for(let my=0;my<mcusY;my++)for(let mx=0;mx<mcusX;mx++){
      if(restart&&index&&index%restart===0){
        reader.bit=0;
        const found=reader.nextByte();
        if(found!==-2||reader.marker!==(0xD0+(rst&7)))throw err('jpeg');
        reader.marker=-1;rst++;pred.clear();
      }
      index++;
      const planes=[];
      for(const part of scan){
        const comp=byId.get(part.id);
        const q=comp&&quant[comp.q];
        const dc=huff.dc[part.dc],ac=huff.ac[part.ac];
        if(!comp||!q||!dc||!ac)throw err('jpeg');
        const data=[];
        let previous=pred.get(comp.id)||0;
        for(let vy=0;vy<comp.v;vy++)for(let vx=0;vx<comp.h;vx++){
          const block=decodeBlock(reader,dc,ac,q,previous);
          previous=block.dc;
          data.push(block.sample);
        }
        pred.set(comp.id,previous);
        planes.push({comp,data,v:comp.v});
      }
      for(let py=0;py<mcuH;py++)for(let px=0;px<mcuW;px++){
        const x=mx*mcuW+px,y=my*mcuH+py;
        if(x>=frame.width||y>=frame.height)continue;
        let r,g,b;
        if(planes.length===1){const yValue=sampleBlock(planes[0],planes[0].comp.h,px,py,frame.maxH,frame.maxV);r=g=b=yValue;}
        else{
          const yValue=sampleBlock(planes[0],planes[0].comp.h,px,py,frame.maxH,frame.maxV);
          const cb=sampleBlock(planes[1],planes[1].comp.h,px,py,frame.maxH,frame.maxV);
          const cr=sampleBlock(planes[2],planes[2].comp.h,px,py,frame.maxH,frame.maxV);
          r=yValue+1.402*(cr-128);
          g=yValue-0.344136*(cb-128)-0.714136*(cr-128);
          b=yValue+1.772*(cb-128);
        }
        const d=(y*frame.width+x)*4;
        rgba[d]=clamp8(r);rgba[d+1]=clamp8(g);rgba[d+2]=clamp8(b);rgba[d+3]=255;
      }
    }
    return {width:frame.width,height:frame.height,rgba};
  }
  function clamp8(n){n=Math.round(n);return n<0?0:n>255?255:n;}
  function encodeB64(bytes){
    let bin='';
    for(let i=0;i<bytes.length;i+=8192){
      const part=bytes.subarray(i,i+8192);
      for(let j=0;j<part.length;j++)bin+=String.fromCharCode(part[j]);
    }
    return root.btoa(bin);
  }
  function decodeB64(data){
    if(typeof data!=='string'||!data||data.length>36000000||data.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))return null;
    let bin;
    try{bin=root.atob(data);}catch{return null;}
    const out=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i)&255;
    return out;
  }
  async function digest(bytes){
    const copy=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
    const buf=await root.crypto.subtle.digest('SHA-256',copy);
    return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  function mapPixelBox(box,region,width,height){
    if(!bboxOk(box)||!bboxOk(region)||!finite(width)||!finite(height)||width<1||height<1)return null;
    if(box[0]<-1||box[1]<-1||box[2]>width+1||box[3]>height+1)return null;
    const mapped=[
      round4(region[0]+box[0]/width*(region[2]-region[0])),
      round4(region[1]+box[1]/height*(region[3]-region[1])),
      round4(region[0]+box[2]/width*(region[2]-region[0])),
      round4(region[1]+box[3]/height*(region[3]-region[1]))
    ];
    return bboxOk(mapped)?mapped:null;
  }
  function optionalAxis(axis){
    if(!axis||typeof axis!=='object'||Array.isArray(axis))return null;
    if(axis.scale!=='linear'&&axis.scale!=='log')return null;
    const out={scale:axis.scale};
    if(axis.label!=null){
      if(typeof axis.label!=='string'||axis.label.length>200)return null;
      if(axis.label)out.label=axis.label;
    }
    for(const key of ['min','max']){
      if(axis[key]==null)continue;
      if(!finite(axis[key]))return null;
      out[key]=axis[key];
    }
    return out;
  }
  function normalizeChart(chart){
    if(!chart||typeof chart!=='object'||Array.isArray(chart))return null;
    if(chart.kind!=='line'&&chart.kind!=='scatter'&&chart.kind!=='bar')return null;
    if(typeof chart.title!=='string'||chart.title.length>200)return null;
    const xAxis=optionalAxis(chart.xAxis),yAxis=optionalAxis(chart.yAxis);
    if(!xAxis||!yAxis||!Array.isArray(chart.series)||chart.series.length<1||chart.series.length>12)return null;
    const series=[];
    for(let i=0;i<chart.series.length;i++){
      const entry=chart.series[i];
      if(!entry||typeof entry!=='object'||!Array.isArray(entry.points)||entry.points.length>MAX_POINTS)return null;
      const id=typeof entry.id==='string'&&idOk(entry.id)?entry.id:'s'+(i+1);
      const name=typeof entry.name==='string'?entry.name.slice(0,120):'';
      const color=/^#[0-9a-fA-F]{6}$/.test(entry.color)?entry.color.toLowerCase():['#246388','#8e302b','#111315','#9a6b00'][i%4];
      const points=[];
      for(const point of entry.points){
        if(!point||typeof point!=='object'||!finite(point.x)||!finite(point.y))return null;
        const next={x:point.x,y:point.y};
        for(const key of ['yLow','yHigh']){
          if(!Object.hasOwn(point,key)||point[key]==null)continue;
          if(!finite(point[key]))return null;
          next[key]=point[key];
        }
        points.push(next);
      }
      series.push({id,name,color,points});
    }
    return {kind:chart.kind,title:chart.title,xAxis,yAxis,series};
  }
  function editorFromChart(chart){
    const axis=source=>({scale:source.scale,min:source.min==null?'':String(source.min),max:source.max==null?'':String(source.max),label:source.label||''});
    return {
      kind:chart.kind,title:chart.title,xAxis:axis(chart.xAxis),yAxis:axis(chart.yAxis),
      series:chart.series.map(entry=>({
        id:entry.id,name:entry.name,color:entry.color,
        points:entry.points.map(point=>({x:String(point.x),y:String(point.y),yLow:point.yLow==null?'':String(point.yLow),yHigh:point.yHigh==null?'':String(point.yHigh)}))
      }))
    };
  }
  function parseNum(text,required){
    const value=typeof text==='string'?text.trim():'';
    if(!value)return required?null:undefined;
    if(!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(value))return null;
    const n=Number(value);
    return Number.isFinite(n)?n:null;
  }
  function compileEditor(editor){
    if(!editor)return null;
    const readAxis=(axis,vertical)=>{
      const out={scale:axis.scale==='log'?'log':'linear'};
      if(axis.scale!=='linear'&&axis.scale!=='log')return null;
      if(axis.label&&axis.label.trim())out.label=axis.label.trim().slice(0,200);
      const min=parseNum(axis.min,false),max=parseNum(axis.max,false);
      if(min===null||max===null)return null;
      if(min!=null)out.min=min;
      if(max!=null)out.max=max;
      if(out.min!=null&&out.max!=null&&out.min>=out.max)return null;
      if(out.scale==='log'&&((out.min!=null&&out.min<=0)||(out.max!=null&&out.max<=0)))return null;
      out.vertical=vertical;
      return out;
    };
    const xAxis=readAxis(editor.xAxis,false),yAxis=readAxis(editor.yAxis,true);
    if(!xAxis||!yAxis)return null;
    delete xAxis.vertical;delete yAxis.vertical;
    const series=[];
    for(const entry of editor.series){
      const points=[];
      for(const point of entry.points){
        const x=parseNum(point.x,true),y=parseNum(point.y,true);
        const yLow=parseNum(point.yLow,false),yHigh=parseNum(point.yHigh,false);
        if(x===null||y===null||yLow===null||yHigh===null)return null;
        if(xAxis.scale==='log'&&x<=0)return null;
        if(yAxis.scale==='log'&&(y<=0||(yLow!=null&&yLow<=0)||(yHigh!=null&&yHigh<=0)))return null;
        const next={x,y};
        if(yLow!=null)next.yLow=yLow;
        if(yHigh!=null)next.yHigh=yHigh;
        points.push(next);
      }
      if(!points.length)return null;
      series.push({id:entry.id,name:entry.name,color:entry.color,points});
    }
    return {kind:editor.kind,title:editor.title.trim().slice(0,200),xAxis,yAxis,series};
  }
  function sameJson(a,b){return JSON.stringify(a)===JSON.stringify(b);}
  function validateSummary(data,fileHash){
    if(!data||data.schema!==EVIDENCE_SCHEMA||!paperIdOk(data.paperId)||data.fileHash!==fileHash)return null;
    if(data.status!=='ready'&&data.status!=='partial')return null;
    if(!countOk(data.pageCount)||data.pageCount<1)return null;
    const expiresAt=typeof data.expiresAt==='string'?Date.parse(data.expiresAt):NaN;
    if(!Number.isFinite(expiresAt)||expiresAt<=Date.now())return null;
    return {paperId:data.paperId,fileHash,pageCount:data.pageCount,counts:data.counts||{},expiresAt};
  }
  function validateList(data,paperId,fileHash,offset){
    if(!data||data.paperId!==paperId||data.fileHash!==fileHash||!Array.isArray(data.items)||!countOk(data.total)||data.total<offset)return null;
    const items=[];
    for(const raw of data.items){
      if(!raw||!idOk(raw.id)||(raw.type!=='table'&&raw.type!=='figure')||!Number.isSafeInteger(raw.pageIndex)||raw.pageIndex<0||!bboxOk(raw.bbox))continue;
      items.push({id:raw.id,type:raw.type,pageIndex:raw.pageIndex,bbox:raw.bbox.slice(),caption:typeof raw.caption==='string'?raw.caption:''});
    }
    let next=null;
    if(data.nextOffset!=null){
      if(!Number.isSafeInteger(data.nextOffset)||data.nextOffset<0)return null;
      next=data.nextOffset;
    }
    return {items,total:data.total,nextOffset:next};
  }
  function validateItem(data,paperId,fileHash,itemId){
    if(!data||(data.paperId!=null&&data.paperId!==paperId)||(data.fileHash!=null&&data.fileHash!==fileHash)||data.id!==itemId||(data.type!=='table'&&data.type!=='figure'))return null;
    if(!Number.isSafeInteger(data.pageIndex)||data.pageIndex<0||!bboxOk(data.bbox))return null;
    const item={id:data.id,type:data.type,pageIndex:data.pageIndex,bbox:data.bbox.slice(),caption:typeof data.caption==='string'?data.caption:''};
    if(data.type==='table'){
      const table=data.table;
      if(!table||!Array.isArray(table.cells))return null;
      const cells=[];
      for(const cell of table.cells){
        if(!cell||!Number.isSafeInteger(cell.row)||!Number.isSafeInteger(cell.column)||cell.row<0||cell.column<0||typeof cell.text!=='string')continue;
        cells.push({row:cell.row,column:cell.column,rowSpan:Number.isSafeInteger(cell.rowSpan)&&cell.rowSpan>0?cell.rowSpan:1,columnSpan:Number.isSafeInteger(cell.columnSpan)&&cell.columnSpan>0?cell.columnSpan:1,text:cell.text,bbox:bboxOk(cell.bbox)?cell.bbox.slice():null});
      }
      item.table={rows:table.rows,columns:table.columns,cells};
    }
    return item;
  }
  function validateRender(data,paperId,fileHash,pageIndex,bbox){
    if(!data||data.paperId!==paperId||data.fileHash!==fileHash||data.pageIndex!==pageIndex||data.mimeType!=='image/png'||!closeBox(bbox,data.bbox))return null;
    if(!Number.isSafeInteger(data.width)||!Number.isSafeInteger(data.height)||data.width<1||data.height<1||data.width*data.height>MAX_PIXELS)return null;
    if(typeof data.sha256!=='string'||!HEX.test(data.sha256))return null;
    const bytes=decodeB64(data.data);
    if(!isPng(bytes))return null;
    return {bytes,width:data.width,height:data.height,sha256:data.sha256,bbox:bbox.slice()};
  }
  function validateAnalyses(data,paperId,fileHash){
    if(!data||data.paperId!==paperId||data.fileHash!==fileHash||!Array.isArray(data.items))return null;
    const items=[];
    for(const raw of data.items){
      if(!raw||!idOk(raw.analysisId)||(raw.kind!=='chart'&&raw.kind!=='ocr')||!Number.isSafeInteger(raw.pageIndex)||raw.pageIndex<0)continue;
      if(raw.bbox!=null&&!bboxOk(raw.bbox))continue;
      items.push({analysisId:raw.analysisId,kind:raw.kind,pageIndex:raw.pageIndex,bbox:raw.bbox?raw.bbox.slice():null});
    }
    return items;
  }
  function cellSourceBox(cell,analysis){
    if(bboxOk(cell.sourceBbox))return cell.sourceBbox.slice();
    const image=analysis&&analysis.inputImage;
    return mapPixelBox(cell.bbox,analysis&&analysis.bbox,image&&image.width,image&&image.height);
  }

  function create({host,getSource,getSession,onOutput,onChange,hold}={}){
    if(!host||typeof host.append!=='function'||typeof getSource!=='function'||typeof getSession!=='function'||typeof onOutput!=='function')throw new TypeError('시각 편집 화면 설정이 올바르지 않습니다.');
    const doc=host.ownerDocument||root.document;
    if(!doc||typeof doc.createElement!=='function')throw new TypeError('시각 편집 화면 설정이 올바르지 않습니다.');
    const uid=++instances;
    const radioName='visual-edit-'+uid;
    const headingId='visual-edit-title-'+uid;
    host.classList?.add('paper-visual-edit');
    host.setAttribute?.('role','region');
    host.setAttribute?.('aria-labelledby',headingId);
    if(typeof host.replaceChildren==='function')host.replaceChildren();
    const el=(tag,className,text)=>{const node=doc.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
    const say=(node,text,error=false)=>{node.textContent=text;node.classList.toggle('error',!!error);};
    const heading=el('h2',null,'표·그래프·그림 고치기');
    heading.id=headingId;
    const lead=el('p','visual-edit-lead','선택한 원본만 고칩니다. PDF에 적용을 누르기 전에는 파일이 바뀌지 않습니다.');
    const status=el('p','form-feedback',TEXT.need);
    status.setAttribute('role','status');
    status.setAttribute('aria-live','polite');
    const retry=el('button','button secondary',TEXT.retry);
    retry.type='button';
    retry.hidden=true;
    const layout=el('div','visual-edit-layout');
    const sourceColumn=el('div','visual-edit-column');
    const sourceTitle=el('h3',null,'원본');
    const list=el('div','visual-edit-list');
    list.setAttribute('role','radiogroup');
    list.setAttribute('aria-label','원본 표와 그림');
    const listPager=el('div','visual-edit-pager');
    const listPrev=el('button','button secondary','이전 목록');
    const listNext=el('button','button secondary','다음 목록');
    const listPos=el('span','muted','');
    listPrev.type='button';listNext.type='button';
    listPager.append(listPrev,listNext,listPos);
    const savedTitle=el('h3',null,'저장된 그래프·스캔');
    const saved=el('div','visual-edit-saved');
    saved.setAttribute('role','radiogroup');
    saved.setAttribute('aria-label','저장된 그래프와 스캔');
    const savedPager=el('div','visual-edit-pager');
    const savedPrev=el('button','button secondary','이전 저장');
    const savedNext=el('button','button secondary','다음 저장');
    const savedPos=el('span','muted','');
    savedPrev.type='button';savedNext.type='button';
    savedPager.append(savedPrev,savedNext,savedPos);
    const pickPage=el('button','button secondary','영역 직접 선택');
    pickPage.type='button';
    sourceColumn.append(sourceTitle,list,listPager,pickPage,savedTitle,saved,savedPager);
    const work=el('div','visual-edit-work');
    const workBody=el('div','visual-edit-body');
    const compare=el('p','form-feedback visual-edit-compare','');
    const pair=el('div','visual-edit-pair');
    pair.hidden=true;
    const beforeFigure=el('figure');
    const beforeCap=el('figcaption',null,'이전');
    const beforeImg=el('img','image-preview');
    beforeImg.alt='이전 그림';
    const afterFigure=el('figure');
    const afterCap=el('figcaption',null,'이후');
    const afterImg=el('img','image-preview');
    afterImg.alt='이후 그림';
    beforeFigure.append(beforeCap,beforeImg);
    afterFigure.append(afterCap,afterImg);
    pair.append(beforeFigure,afterFigure);
    work.append(workBody,compare,pair);
    layout.append(sourceColumn,work);
    const actions=el('div','visual-edit-actions');
    const applyBtn=el('button','button primary','PDF에 적용');
    applyBtn.type='button';
    const download=el('a','button secondary','결과 PDF 저장');
    download.hidden=true;
    download.rel='noopener';
    download.download='visual-edit.pdf';
    const blueBtn=el('button','button secondary','이 PDF로 BLUE 검토');
    blueBtn.type='button';
    blueBtn.hidden=true;
    const outputNote=el('p','form-feedback','');
    actions.append(applyBtn,download,blueBtn);
    host.append(heading,lead,status,retry,layout,actions,outputNote);

    let generation=0,selectSerial=0,chartSerial=0,parentBusy=false,applying=false,errorCode=null;
    let paperId=null,boundHash=null,boundRevision=null,pageCount=0,flight=null;
    let listItems=[],listTotal=0,listPage=0,savedItems=[],savedPage=0,selectedKey=null;
    const controllers=[];
    const cellOps=new Map();
    const regionOps=new Map();
    const itemCache=new Map();
    const analysisCache=new Map();
    let chartState=null,figureState=null,chartBlocked=false,output=null,downloadUrl=null,previewUrls=[],imageTask=Promise.resolve(),figureSerial=0;
    let dynamic=[];

    function track(){const controller=new root.AbortController();controllers.push(controller);return controller.signal;}
    function abortAll(){for(const controller of controllers)controller.abort();controllers.length=0;}
    function bump(){generation++;selectSerial++;chartSerial++;abortAll();return generation;}
    function live(token,src){return token===generation&&!!src&&src.fileHash===boundHash&&src.revision===boundRevision;}
    function currentSource(){
      let value;
      try{value=getSource();}catch{return null;}
      if(!value||typeof value!=='object'||typeof value.fileHash!=='string'||!HEX.test(value.fileHash))return null;
      if(typeof value.revision!=='string'||!value.revision||value.revision.length>200||!value.file||typeof value.file.arrayBuffer!=='function')return null;
      return {file:value.file,fileHash:value.fileHash,revision:value.revision};
    }
    function session(){
      let value;
      try{value=getSession();}catch{value=null;}
      if(!value||typeof value.request!=='function')throw err('unavailable');
      return value;
    }
    function opId(prefix){
      const bytes=new Uint8Array(6);
      root.crypto.getRandomValues(bytes);
      return prefix+[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
    }
    function revokePreviews(){for(const url of previewUrls){try{root.URL.revokeObjectURL(url);}catch{}}previewUrls=[];}
    function showPng(img,bytes){
      if(!bytes){img.removeAttribute?.('src');img.hidden=true;return;}
      const url=root.URL.createObjectURL(new root.Blob([bytes],{type:'image/png'}));
      previewUrls.push(url);
      img.src=url;
      img.hidden=false;
    }
    function resetDrafts(){
      cellOps.clear();regionOps.clear();itemCache.clear();analysisCache.clear();
      chartState=null;figureState=null;chartBlocked=false;selectedKey=null;
      revokePreviews();
      pair.hidden=true;
      say(compare,'');
      workBody.replaceChildren();
    }
    function pendingCount(){return cellOps.size+regionOps.size;}
    function records(){return [...cellOps.values(),...regionOps.values()].map(entry=>entry.record);}
    function wires(){return [...cellOps.values(),...regionOps.values()].map(entry=>entry.wire);}
    function emit(){if(typeof onChange==='function'){try{onChange({changes:records()});}catch{}}if(output)say(outputNote,outputReady()?'현재 편집을 반영한 PDF입니다.':'마지막 생성 PDF입니다. 지금 편집은 PDF에 적용을 눌러 반영하세요.');}
    function outputReady(){
      const src=currentSource();
      return !!(output&&src&&src.fileHash===output.source&&src.revision===output.revision&&output.draftKey===JSON.stringify(records()));
    }
    function syncDisabled(){
      const lock=parentBusy||applying;
      applyBtn.disabled=lock||pendingCount()===0||!paperId;
      blueBtn.disabled=lock||!outputReady();
      blueBtn.hidden=!outputReady();
      retry.disabled=lock;
      pickPage.disabled=lock||!paperId;
      listPrev.disabled=lock||listPage<=0;
      listNext.disabled=lock||(listPage+1)*LIST_PAGE>=listTotal;
      savedPrev.disabled=lock||savedPage<=0;
      savedNext.disabled=lock||(savedPage+1)*LIST_PAGE>=savedItems.length;
      listPos.textContent=listTotal?((listPage+1)+' / '+Math.max(1,Math.ceil(listTotal/LIST_PAGE))):'';
      savedPos.textContent=savedItems.length?((savedPage+1)+' / '+Math.max(1,Math.ceil(savedItems.length/LIST_PAGE))):'';
      for(const node of dynamic)node.disabled=lock||node._softLock===true;
    }
    function paintOutput(){
      if(downloadUrl){try{root.URL.revokeObjectURL(downloadUrl);}catch{}downloadUrl=null;}
      if(!output){download.hidden=true;download.removeAttribute?.('href');say(outputNote,'');syncDisabled();return;}
      downloadUrl=root.URL.createObjectURL(new root.Blob([output.bytes],{type:'application/pdf'}));
      download.href=downloadUrl;
      download.hidden=false;
      say(outputNote,outputReady()?'현재 편집을 반영한 PDF입니다.':'마지막 생성 PDF입니다. 지금 편집은 PDF에 적용을 눌러 반영하세요.');
      syncDisabled();
    }
    async function deliver(intent='record'){
      if(!outputReady())return;
      const payload={
        file:new root.File([output.bytes.slice()],'visual-edit.pdf',{type:'application/pdf'}),
        bytes:output.bytes.slice(),
        outputFileHash:output.hash,
        changes:output.changes,
        verification:output.verification
      };
      await onOutput(payload,{intent});
    }
    function nested(parent,node){
      const stack=[...(parent.children||[])];
      while(stack.length){
        const current=stack.pop();
        if(current===node)return true;
        if(current&&current.children)stack.push(...current.children);
      }
      return false;
    }
    function radioRow(item,kind){
      const row=el('label','visual-edit-row');
      const input=el('input');
      input.type='radio';
      input.name=radioName;
      input.value=kind+':'+item.id;
      input.checked=selectedKey===input.value;
      const text=el('span');
      const title=kind==='item'
        ?(item.type==='table'?'표':'그림')+' · '+(item.pageIndex+1)+'쪽'
        :(item.kind==='chart'?'그래프':'스캔 표')+' · '+(item.pageIndex+1)+'쪽';
      text.append(el('strong',null,title));
      if(item.caption)text.append(el('small',null,clip(item.caption,180)));
      input.addEventListener('change',()=>{if(input.checked)void select(input.value);});
      row.append(input,text);
      dynamic.push(input);
      return row;
    }
    function paintLists(){
      dynamic=dynamic.filter(node=>!nested(list,node)&&!nested(saved,node));
      list.replaceChildren();
      saved.replaceChildren();
      if(!listItems.length)list.append(el('p','muted',TEXT.empty));
      else for(const item of listItems)list.append(radioRow(item,'item'));
      const slice=savedItems.slice(savedPage*LIST_PAGE,(savedPage+1)*LIST_PAGE);
      if(!slice.length)saved.append(el('p','muted',TEXT.empty));
      else for(const item of slice)saved.append(radioRow({id:item.analysisId,kind:item.kind,pageIndex:item.pageIndex},'analysis'));
      sourceTitle.textContent='원본 · '+listTotal;
      savedTitle.textContent='저장된 그래프·스캔 · '+savedItems.length;
      syncDisabled();
    }
    async function loadList(token,src,page){
      const signal=track();
      const data=await session().request(QUERY,{paperId,operation:'list',offset:page*LIST_PAGE,limit:LIST_PAGE},{signal});
      if(!live(token,src))return;
      const parsed=validateList(data,paperId,src.fileHash,page*LIST_PAGE);
      if(!parsed){say(status,TEXT.listFailed,true);errorCode='failed';return;}
      listItems=parsed.items;
      listTotal=parsed.total;
      listPage=page;
      paintLists();
    }
    async function renderRegion(pageIndex,bbox){
      const signal=track();
      const data=await session().request(QUERY,{paperId,operation:'render',pageIndex,bbox:bbox.slice(),dpi:150},{signal});
      const parsed=validateRender(data,paperId,boundHash,pageIndex,bbox);
      if(!parsed)return null;
      const actual=await digest(parsed.bytes);
      if(actual!==parsed.sha256)return null;
      return parsed;
    }
    function setImages(before,after){
      revokePreviews();
      showPng(beforeImg,before);
      showPng(afterImg,after);
      pair.hidden=!before&&!after;
    }
    async function select(value){
      if(parentBusy||applying){paintLists();return;}
      const token=generation;
      const mine=++selectSerial;
      selectedKey=value;
      const parsed=value.split(':');
      const kind=parsed.shift();
      const id=parsed.join(':');
      workBody.replaceChildren();
      say(compare,'');
      try{
        if(kind==='item'){
          let item=itemCache.get(id);
          if(!item){
            const signal=track();
            const data=await session().request(QUERY,{paperId,operation:'item',itemId:id},{signal});
            if(token!==generation||mine!==selectSerial)return;
            item=validateItem(data,paperId,boundHash,id);
            if(!item){say(status,TEXT.failed,true);return;}
            itemCache.set(id,item);
          }
          if(token!==generation||mine!==selectSerial)return;
          if(item.type==='table')paintTable(item);
          else await paintFigure(item,token,mine);
        }else{
          let analysis=analysisCache.get(id);
          if(!analysis){
            const signal=track();
            const data=await session().request(QUERY,{paperId,operation:'analysis',analysisId:id},{signal});
            if(token!==generation||mine!==selectSerial)return;
            if(!data||data.paperId!==paperId||data.fileHash!==boundHash||data.analysisId!==id){say(status,TEXT.failed,true);return;}
            analysis=data;
            analysisCache.set(id,analysis);
          }
          if(token!==generation||mine!==selectSerial)return;
          if(analysis.kind==='chart')await paintChart(analysis,token,mine);
          else paintOcr(analysis);
        }
      }catch(error){
        if(error?.name==='AbortError'||token!==generation||mine!==selectSerial)return;
        say(status,TEXT[codeOf(error)]||TEXT.failed,true);
        errorCode=codeOf(error);
      }
      syncDisabled();
    }
    function paintTable(item){
      figureState=null;chartState=null;
      let page=0;
      const rows=[...new Set(item.table.cells.map(cell=>cell.row))].sort((a,b)=>a-b);
      const panel=el('div','visual-edit-column');
      const title=el('h3',null,'표 · '+(item.pageIndex+1)+'쪽');
      const grid=el('div','visual-edit-grid');
      const pager=el('div','visual-edit-pager');
      const prev=el('button','button secondary','이전 줄');
      const next=el('button','button secondary','다음 줄');
      const pos=el('span','muted','');
      prev.type='button';next.type='button';
      pager.append(prev,next,pos);
      panel.append(title,grid,pager);
      function paint(){
        dynamic=dynamic.filter(node=>!nested(grid,node));
        const shown=rows.slice(page*ROW_PAGE,(page+1)*ROW_PAGE);
        const table=el('table');
        const body=el('tbody');
        for(const rowIndex of shown){
          const row=el('tr');
          row.append(el('th',null,String(rowIndex+1)));
          for(const cell of item.table.cells.filter(entry=>entry.row===rowIndex).sort((a,b)=>a.column-b.column)){
            const td=el('td');
            td.rowSpan=cell.rowSpan||1;td.colSpan=cell.columnSpan||1;
            const key=item.id+'\n'+cell.row+'\n'+cell.column;
            const existing=cellOps.get(key);
            const label=el('label');
            label.append(el('span','muted','이전 '+cell.text));
            const input=el('input');
            input.value=existing?existing.wire.after:cell.text;
            input.setAttribute('aria-label','행 '+(cell.row+1)+' 열 '+(cell.column+1));
            input.addEventListener('input',()=>{
              if(parentBusy||applying){input.value=existing?existing.wire.after:cell.text;return;}
              const after=input.value;
              if(after===cell.text)cellOps.delete(key);
              else{
                const prior=cellOps.get(key);
                const id=prior?prior.wire.id:opId('c');
                cellOps.set(key,{
                  wire:{id,kind:'table-cell',itemId:item.id,row:cell.row,column:cell.column,before:cell.text,after},
                  record:{id,kind:'table-cell',itemId:item.id,row:cell.row,column:cell.column,before:cell.text,after,pageIndex:item.pageIndex,bbox:cell.bbox?cell.bbox.slice():item.bbox.slice(),author:'human'}
                });
              }
              paintChanged();
              emit();
              syncDisabled();
            });
            label.append(input);
            td.append(label);
            row.append(td);
            dynamic.push(input);
          }
          body.append(row);
        }
        table.append(body);
        grid.replaceChildren(table);
        prev.disabled=parentBusy||applying||page<=0;
        next.disabled=parentBusy||applying||(page+1)*ROW_PAGE>=rows.length;
        pos.textContent=rows.length?((page+1)+' / '+Math.ceil(rows.length/ROW_PAGE)):'';
        syncDisabled();
      }
      function paintChanged(){
        const lines=[];
        for(const entry of cellOps.values())if(entry.wire.itemId===item.id)lines.push('이전 '+entry.wire.before+'\n이후 '+entry.wire.after);
        say(compare,lines.join('\n\n'));
      }
      prev.addEventListener('click',()=>{if(!parentBusy&&!applying&&page>0){page--;paint();}});
      next.addEventListener('click',()=>{if(!parentBusy&&!applying&&(page+1)*ROW_PAGE<rows.length){page++;paint();}});
      workBody.replaceChildren(panel);
      paint();
      paintChanged();
      setImages(null,null);
    }
    async function paintChart(analysis,token,mine){
      figureState=null;
      const api=root.FalsifyChartRedraw;
      if(!api||typeof api.fromAnalysis!=='function'||typeof api.render!=='function'){say(status,TEXT.chartMissing,true);errorCode='chart-missing';return;}
      let raw=null;
      try{raw=normalizeChart(api.fromAnalysis(analysis));}catch{raw=null;}
      if(!raw&&analysis.data){try{raw=normalizeChart(api.fromAnalysis(analysis.data));}catch{raw=null;}}
      if(!raw){say(status,TEXT.chartBad,true);errorCode='chart-bad';return;}
      const bbox=bboxOk(analysis.bbox)?analysis.bbox.slice():null;
      chartState={analysis,original:raw,editor:editorFromChart(raw),bbox,pageIndex:analysis.pageIndex,key:'graph:'+analysis.analysisId,opId:'graph-'+analysis.analysisId};
      chartBlocked=false;
      const panel=el('div','visual-edit-column');
      const title=el('h3',null,'그래프 · '+(analysis.pageIndex+1)+'쪽');
      const note=el('p','muted',TEXT.note);
      const fields=el('div','visual-edit-fields');
      const titleInput=field('제목',chartState.editor.title,value=>{chartState.editor.title=value;queueChart();});
      const kind=el('select');
      for(const value of ['line','scatter','bar']){const option=el('option',null,value==='line'?'선':value==='scatter'?'점':'막대');option.value=value;kind.append(option);}
      kind.value=chartState.editor.kind;
      kind.addEventListener('change',()=>{chartState.editor.kind=kind.value;queueChart();});
      const xScale=scaleSelect(chartState.editor.xAxis);
      const yScale=scaleSelect(chartState.editor.yAxis);
      fields.append(titleInput,labeledSelect('종류',kind),labeledSelect('가로 눈금',xScale),labeledSelect('세로 눈금',yScale));
      const seriesHost=el('div');
      const advanced=el('details');
      advanced.append(el('summary',null,'축 범위'));
      const axisBox=el('div','visual-edit-advanced visual-edit-fields');
      axisBox.append(
        field('가로 이름',chartState.editor.xAxis.label,value=>{chartState.editor.xAxis.label=value;queueChart();}),
        field('가로 최소',chartState.editor.xAxis.min,value=>{chartState.editor.xAxis.min=value;queueChart();}),
        field('가로 최대',chartState.editor.xAxis.max,value=>{chartState.editor.xAxis.max=value;queueChart();}),
        field('세로 이름',chartState.editor.yAxis.label,value=>{chartState.editor.yAxis.label=value;queueChart();}),
        field('세로 최소',chartState.editor.yAxis.min,value=>{chartState.editor.yAxis.min=value;queueChart();}),
        field('세로 최대',chartState.editor.yAxis.max,value=>{chartState.editor.yAxis.max=value;queueChart();})
      );
      advanced.append(axisBox);
      const replot=el('button','button secondary','다시 그리기');
      replot.type='button';
      replot.addEventListener('click',()=>{void flushChart(generation);});
      panel.append(title,note,fields,seriesHost,advanced,replot);
      workBody.replaceChildren(panel);
      dynamic.push(kind,xScale,yScale,replot);
      paintSeries();
      let before=null;
      if(bbox)before=await renderRegion(analysis.pageIndex,bbox);
      if(token!==generation||mine!==selectSerial)return;
      chartState.before=before;
      setImages(before&&before.bytes,null);
      await flushChart(token);
      function field(label,value,commit){
        const wrap=el('label');
        wrap.append(el('span',null,label));
        const input=el('input');
        input.value=value;
        input.addEventListener('input',()=>{if(parentBusy||applying)return;commit(input.value);});
        wrap.append(input);
        dynamic.push(input);
        return wrap;
      }
      function scaleSelect(axis){
        const select=el('select');
        for(const value of ['linear','log']){const option=el('option',null,value==='linear'?'선형':'로그');option.value=value;select.append(option);}
        select.value=axis.scale;
        select.addEventListener('change',()=>{axis.scale=select.value==='log'?'log':'linear';queueChart();});
        return select;
      }
      function labeledSelect(label,select){
        const wrap=el('label');
        wrap.append(el('span',null,label),select);
        return wrap;
      }
      function paintSeries(){
        seriesHost.replaceChildren();
        chartState.editor.series.forEach((entry,seriesIndex)=>{
          const box=el('div','visual-edit-series');
          const name=el('input');
          name.value=entry.name;
          name.setAttribute('aria-label','계열 '+(seriesIndex+1)+' 이름');
          name.addEventListener('input',()=>{entry.name=name.value;queueChart();});
          const color=el('input');
          color.type='color';
          color.value=entry.color;
          color.setAttribute('aria-label','계열 '+(seriesIndex+1)+' 색');
          color.addEventListener('input',()=>{entry.color=color.value;queueChart();});
          const points=el('div','visual-edit-points');
          entry.points.forEach((point,pointIndex)=>points.append(pointRow(entry,point,pointIndex)));
          const add=el('button','button secondary','점 추가');
          add.type='button';
          add.addEventListener('click',()=>{
            if(entry.points.length>=MAX_POINTS)return;
            entry.points.push({x:'',y:'',yLow:'',yHigh:''});
            paintSeries();
            queueChart();
          });
          box.append(name,color,points,add);
          seriesHost.append(box);
          dynamic.push(name,color,add);
        });
        syncDisabled();
      }
      function pointRow(entry,point,pointIndex){
        const row=el('div','visual-edit-point');
        for(const [key,label] of [['x','가로'],['y','세로'],['yLow','낮은값'],['yHigh','높은값']]){
          const wrap=el('label');
          wrap.append(el('span',null,label));
          const input=el('input');
          input.value=point[key];
          input.inputMode='decimal';
          input.setAttribute('aria-label','점 '+(pointIndex+1)+' '+label);
          input.addEventListener('input',()=>{point[key]=input.value;queueChart();});
          wrap.append(input);
          row.append(wrap);
          dynamic.push(input);
        }
        const remove=el('button','button secondary','삭제');
        remove.type='button';
        remove.addEventListener('click',()=>{entry.points.splice(pointIndex,1);paintSeries();queueChart();});
        row.append(remove);
        dynamic.push(remove);
        return row;
      }
    }
    let chartQueued=false;
    function queueChart(){
      chartBlocked=false;
      if(chartQueued)return;
      chartQueued=true;
      queueMicrotask(()=>{chartQueued=false;void flushChart(generation);});
    }
    async function flushChart(token){
      if(!chartState)return;
      const mine=++chartSerial;
      const compiled=compileEditor(chartState.editor);
      const dirty=!sameJson(compiled,chartState.original);
      if(!compiled){
        chartBlocked=editorDirty(chartState);
        if(chartBlocked){regionOps.delete(chartState.key);say(status,TEXT.chartInvalid,true);errorCode='invalid';emit();syncDisabled();}
        return;
      }
      chartBlocked=false;
      if(!dirty){regionOps.delete(chartState.key);emit();syncDisabled();return;}
      try{
        const api=root.FalsifyChartRedraw;
        const ratio=chartState.bbox?(chartState.bbox[3]-chartState.bbox[1])/(chartState.bbox[2]-chartState.bbox[0]):.625;
        const rendered=await api.render({chart:compiled,width:640,height:Math.max(64,Math.min(1600,Math.round(640*ratio))),document:doc});
        if(token!==generation||mine!==chartSerial||!chartState)return;
        const png=rendered&&rendered.png instanceof Uint8Array?rendered.png:null;
        if(!isPng(png))throw err('plotFailed');
        let before=chartState.before;
        if(chartState.bbox){
          before=await renderRegion(chartState.pageIndex,chartState.bbox);
          if(token!==generation||mine!==chartSerial||!chartState)return;
          if(!before)throw err('region');
          chartState.before=before;
        }
        if(!before)throw err('region');
        const sha=await digest(png);
        regionOps.set(chartState.key,{
          wire:{id:chartState.opId,kind:'region',assetKind:'graph',pageIndex:chartState.pageIndex,bbox:before.bbox.slice(),beforeImageSha256:before.sha256,png:encodeB64(png),dataChanges:{before:chartState.original,after:compiled}},
          record:{id:chartState.opId,kind:'region',assetKind:'graph',pageIndex:chartState.pageIndex,bbox:before.bbox.slice(),before:chartState.original,after:compiled,author:'human'}
        });
        chartState.after=png;
        setImages(before.bytes,png);
        say(compare,'이전 그래프\n이후 그래프');
        errorCode=null;
        emit();
        syncDisabled();
      }catch(error){
        if(error?.name==='AbortError'||token!==generation||mine!==chartSerial)return;
        say(status,TEXT.plotFailed,true);
        errorCode='plot';
      }
    }
    function editorDirty(state){
      const current=compileEditor(state.editor);
      if(current)return !sameJson(current,state.original);
      return JSON.stringify(state.editor)!==JSON.stringify(editorFromChart(state.original));
    }
    async function selectPage(){
      if(parentBusy||applying||!paperId)return;
      const token=generation,mine=++selectSerial,src=currentSource();
      try{
        const view=await root.FalsifyBlueVisual.previewBluePage({file:src.file,fileHash:src.fileHash,page:1});
        if(!live(token,src)||mine!==selectSerial)return;
        selectedKey='figure:page-region';paintLists();
        await paintFigure({id:'page-region',pageIndex:0,bbox:[0,0,view.width,view.height]},token,mine);
        say(status,'페이지에서 고칠 영역을 드래그하세요.');
      }catch{if(token===generation)say(status,TEXT.previewFailed,true);}
    }
    pickPage.addEventListener('click',()=>{void selectPage();});
    async function paintFigure(item,token,mine){
      chartState=null;
      const rendered=await renderRegion(item.pageIndex,item.bbox);
      if(token!==generation||mine!==selectSerial)return;
      if(!rendered){say(status,TEXT.previewFailed,true);errorCode='preview';return;}
      figureState={key:'figure:'+item.id,opId:'figure-'+item.id,itemId:item.id,pageIndex:item.pageIndex,bbox:item.bbox.slice(),beforeSha:rendered.sha256,beforePng:rendered.bytes,uploaded:null,crop:null,label:null,afterPng:null,page:item.pageIndex+1};
      paintFigureControls();
      setImages(rendered.bytes,null);
      await loadPreview(token,mine);
    }
    function paintFigureControls(){
      const fig=figureState;
      const panel=el('div','visual-edit-column');
      const title=el('h3',null,'그림 · '+(fig.pageIndex+1)+'쪽');
      const nav=el('div','visual-edit-pager');
      const prev=el('button','button secondary','이전 쪽');
      const next=el('button','button secondary','다음 쪽');
      const pageLabel=el('span','muted','');
      prev.type='button';next.type='button';
      nav.append(prev,next,pageLabel);
      const stage=el('div','visual-edit-stage');
      const fileLabel=el('label','button secondary','바꿀 이미지');
      const file=el('input');
      file.type='file';
      file.accept='image/png,image/jpeg';
      file.setAttribute('aria-label','바꿀 이미지');
      file.addEventListener('change',()=>{imageTask=onFile(file.files&&file.files[0]);});
      fileLabel.append(file);
      const labelInput=el('input');
      labelInput.setAttribute('aria-label','라벨');
      labelInput.placeholder='라벨';
      const labelBtn=el('button','button secondary','라벨 놓기');
      labelBtn.type='button';
      labelBtn.addEventListener('click',()=>{
        if(!labelInput.value.trim()){say(status,TEXT.labelNeed,true);return;}
        fig.labelArmed=true;
        say(status,TEXT.labelPlace);
      });
      const advanced=el('details');
      advanced.append(el('summary',null,'영역 숫자와 자르기'));
      const box=el('div','visual-edit-advanced visual-edit-fields');
      const nums={};
      for(const [key,label] of [['page','쪽'],['x0','왼쪽'],['y0','위'],['x1','오른쪽'],['y1','아래'],['cx','자르기 시작 가로'],['cy','자르기 시작 세로'],['cw','자르기 폭'],['ch','자르기 높이']]){
        const input=el('input');
        input.inputMode='decimal';
        input.setAttribute('aria-label',label);
        input.value=key==='page'?String(fig.page):'';
        nums[key]=input;
        const wrap=el('label');
        wrap.append(el('span',null,label),input);
        box.append(wrap);
        dynamic.push(input);
      }
      const useRegion=el('button','button secondary','이 영역 사용');
      const useCrop=el('button','button secondary','이미지 자르기');
      useRegion.type='button';useCrop.type='button';
      useRegion.addEventListener('click',()=>{imageTask=applyNumericRegion(nums);});
      useCrop.addEventListener('click',()=>{imageTask=applyCrop(nums);});
      box.append(useRegion,useCrop);
      advanced.append(box);
      panel.append(title,nav,stage,fileLabel,labelInput,labelBtn,advanced);
      workBody.replaceChildren(panel);
      dynamic.push(prev,next,file,labelBtn,useRegion,useCrop);
      prev.addEventListener('click',()=>{if(fig.page>1)void setPage(fig.page-1);});
      next.addEventListener('click',()=>{if(!fig.pages||fig.page<fig.pages)void setPage(fig.page+1);});
      let drag=null;
      stage.addEventListener('pointerdown',event=>{
        if(parentBusy||applying||!fig.view||event.button)return;
        const start=pointOf(event);
        if(!start)return;
        drag=fig.labelArmed?null:{...start,id:event.pointerId};
        if(fig.labelArmed)drag={label:true,...start,id:event.pointerId};
        stage.setPointerCapture?.(event.pointerId);
      });
      stage.addEventListener('pointermove',event=>{
        if(!drag||drag.label||event.pointerId!==drag.id||!fig.view)return;
        const current=pointOf(event);
        if(!current)return;
        paintOverlay([Math.min(drag.x,current.x),Math.min(drag.y,current.y),Math.max(drag.x,current.x),Math.max(drag.y,current.y)]);
      });
      stage.addEventListener('pointerup',event=>{
        if(!drag||event.pointerId!==drag.id)return;
        const current=pointOf(event);
        const start=drag;
        drag=null;
        if(start.label){
          fig.labelArmed=false;
          if(!current||Math.hypot(current.x-start.x,current.y-start.y)>1.5){say(status,TEXT.labelMiss,true);return;}
          imageTask=placeLabel(labelInput.value,current);
          return;
        }
        if(!current)return;
        const box=[roundPt(Math.min(start.x,current.x)),roundPt(Math.min(start.y,current.y)),roundPt(Math.max(start.x,current.x)),roundPt(Math.max(start.y,current.y))];
        if(box[2]-box[0]<1||box[3]-box[1]<1){paintOverlay(fig.bbox);say(status,'영역이 너무 작습니다. 다시 드래그하세요.',true);return;}
        imageTask=updateFigureBbox(box);
      });
      stage.addEventListener('pointercancel',()=>{drag=null;paintOverlay(fig.bbox);});
      fig.stage=stage;
      fig.pageLabel=pageLabel;
      fig.prev=prev;
      fig.next=next;
      syncDisabled();
      function pointOf(event){
        const rect=fig.view&&fig.view.canvas&&fig.view.canvas.getBoundingClientRect&&fig.view.canvas.getBoundingClientRect();
        if(!rect||!rect.width||!rect.height)return null;
        const x=Math.max(0,Math.min(fig.view.width,(event.clientX-rect.left)/rect.width*fig.view.width));
        const y=Math.max(0,Math.min(fig.view.height,(event.clientY-rect.top)/rect.height*fig.view.height));
        return {x:roundPt(x),y:roundPt(y)};
      }
    }
    async function loadPreview(token,mine){
      const fig=figureState;
      if(!fig)return;
      const src=currentSource();
      const preview=root.FalsifyBlueVisual&&root.FalsifyBlueVisual.previewBluePage;
      if(typeof preview!=='function'){say(status,TEXT.previewMissing,true);return;}
      if(!src)return;
      try{
        const view=await preview({file:src.file,fileHash:src.fileHash,page:fig.page});
        if(token!==generation||mine!==selectSerial||figureState!==fig)return;
        if(!view||!view.canvas||!finite(view.width)||!finite(view.height)||view.width<=0||view.height<=0){say(status,TEXT.previewFailed,true);return;}
        fig.view={canvas:view.canvas,width:view.width,height:view.height,page:view.page,pages:view.pages};
        fig.pages=view.pages;
        fig.pageLabel.textContent=view.page+' / '+view.pages+'쪽';
        const frame=el('div','visual-edit-frame');
        const overlay=el('div','visual-edit-selection');
        overlay.hidden=true;
        frame.append(view.canvas,overlay);
        fig.stage.replaceChildren(frame);
        fig.overlay=overlay;
        paintOverlay(fig.page===fig.pageIndex+1?fig.bbox:null);
        syncDisabled();
      }catch(error){
        if(token!==generation||mine!==selectSerial)return;
        say(status,TEXT[codeOf(error)]||TEXT.previewFailed,true);
      }
    }
    function paintOverlay(box){
      const fig=figureState;
      if(!fig||!fig.overlay||!fig.view)return;
      if(!box){fig.overlay.hidden=true;return;}
      fig.overlay.hidden=false;
      fig.overlay.style.left=(100*box[0]/fig.view.width)+'%';
      fig.overlay.style.top=(100*box[1]/fig.view.height)+'%';
      fig.overlay.style.width=(100*(box[2]-box[0])/fig.view.width)+'%';
      fig.overlay.style.height=(100*(box[3]-box[1])/fig.view.height)+'%';
    }
    async function setPage(page){
      const fig=figureState;
      if(!fig||!Number.isSafeInteger(page)||page<1)return;
      fig.page=page;
      fig.label=null;
      await loadPreview(generation,selectSerial);
    }
    async function updateFigureBbox(bbox){
      const fig=figureState;
      const token=generation,mine=selectSerial;
      const rendered=await renderRegion(fig.page-1,bbox);
      if(token!==generation||mine!==selectSerial||figureState!==fig)return;
      if(!rendered){say(status,TEXT.region,true);return;}
      fig.pageIndex=fig.page-1;
      fig.bbox=bbox.slice();
      fig.beforePng=rendered.bytes;
      fig.beforeSha=rendered.sha256;
      fig.label=null;
      paintOverlay(bbox);
      await composeFigure();
    }
    async function onFile(file){
      if(!file||!figureState||parentBusy||applying)return;
      try{
        const bytes=new Uint8Array(await file.arrayBuffer());
        if(bytes.length>MAX_IMAGE)throw err('imageLimit');
        let png;
        if(isPng(bytes))png=bytes;
        else if(isJpeg(bytes)){
          const image=await decodeJpeg(bytes);
          png=await encodePng(image);
        }else throw err('image');
        figureState.uploaded=png;
        figureState.crop=null;
        await composeFigure();
      }catch(error){
        say(status,TEXT[codeOf(error)]||TEXT.jpeg,true);
        errorCode=codeOf(error);
      }
    }
    async function placeLabel(text,at){
      const fig=figureState;
      const value=String(text||'').replace(/[\u0000-\u001f]/g,'').trim();
      if(!value){say(status,TEXT.labelNeed,true);return;}
      if(at.x<fig.bbox[0]||at.y<fig.bbox[1]||at.x>fig.bbox[2]||at.y>fig.bbox[3]){say(status,TEXT.labelMiss,true);return;}
      const image=await decodePng(fig.uploaded||fig.beforePng);
      const px=(at.x-fig.bbox[0])/(fig.bbox[2]-fig.bbox[0])*image.width;
      const py=(at.y-fig.bbox[1])/(fig.bbox[3]-fig.bbox[1])*image.height;
      fig.label={text:value,x:Math.max(0,px),y:Math.max(0,py)};
      try{await composeFigure();}
      catch(error){say(status,TEXT[codeOf(error)]||TEXT.labelFont,true);errorCode=codeOf(error);}
    }
    async function applyNumericRegion(nums){
      const page=Number(nums.page.value);
      const box=[Number(nums.x0.value),Number(nums.y0.value),Number(nums.x1.value),Number(nums.y1.value)];
      if(!Number.isSafeInteger(page)||page<1||!bboxOk(box)){say(status,TEXT.region,true);return;}
      if(figureState){figureState.page=page;await updateFigureBbox(box.map(roundPt));}
    }
    async function applyCrop(nums){
      const fig=figureState;
      if(!fig||!fig.uploaded){say(status,TEXT.crop,true);return;}
      const crop={x:Number(nums.cx.value),y:Number(nums.cy.value),w:Number(nums.cw.value),h:Number(nums.ch.value)};
      if(!Number.isSafeInteger(crop.x)||!Number.isSafeInteger(crop.y)||!Number.isSafeInteger(crop.w)||!Number.isSafeInteger(crop.h)||crop.h<1){say(status,TEXT.crop,true);return;}
      fig.crop=crop;
      try{await composeFigure();}
      catch(error){say(status,TEXT[codeOf(error)]||TEXT.crop,true);errorCode=codeOf(error);}
    }
    async function composeFigure(){
      const mine=++figureSerial;
      const fig=figureState;
      if(!fig)return;
      let png=null;
      if(fig.uploaded&&!fig.crop&&!fig.label)png=fig.uploaded;
      else if(fig.uploaded||fig.label){
        let image=await decodePng(fig.uploaded||fig.beforePng);
        if(fig.crop){
          image=cropRgba(image,fig.crop);
          if(!image)throw err('crop');
        }
        png=fig.label?await rasterText(image,fig.label.text,fig.label,'label',doc):await encodePng(image);
      }
      if(!png){regionOps.delete(fig.key);fig.afterPng=null;setImages(fig.beforePng,null);emit();syncDisabled();return;}
      const sha=await digest(png);
      if(figureState!==fig||mine!==figureSerial)return;
      regionOps.set(fig.key,{
        wire:{id:fig.opId,kind:'region',assetKind:'figure',pageIndex:fig.pageIndex,bbox:fig.bbox.slice(),beforeImageSha256:fig.beforeSha,png:encodeB64(png)},
        record:{id:fig.opId,kind:'region',assetKind:'figure',pageIndex:fig.pageIndex,bbox:fig.bbox.slice(),before:fig.beforeSha,after:sha,author:'human'}
      });
      fig.afterPng=png;
      setImages(fig.beforePng,png);
      say(compare,'이전 그림\n이후 그림');
      emit();
      syncDisabled();
    }
    function paintOcr(analysis){
      chartState=null;figureState=null;
      const tables=analysis.data&&Array.isArray(analysis.data.tables)?analysis.data.tables:[];
      const panel=el('div','visual-edit-column');
      panel.append(el('h3',null,'스캔 표 · '+(analysis.pageIndex+1)+'쪽'));
      if(!tables.length){panel.append(el('p','muted','스캔 표가 없습니다.'));workBody.replaceChildren(panel);return;}
      let tableIndex=0,page=0;
      const picker=el('select');
      picker.setAttribute('aria-label','스캔 표');
      tables.forEach((table,index)=>{const option=el('option',null,'스캔 표 '+(index+1));option.value=String(index);picker.append(option);});
      picker.addEventListener('change',()=>{tableIndex=Number(picker.value)||0;page=0;paint();});
      const note=el('p','form-feedback','');
      const grid=el('div','visual-edit-grid');
      const pager=el('div','visual-edit-pager');
      const prev=el('button','button secondary','이전 줄');
      const next=el('button','button secondary','다음 줄');
      prev.type='button';next.type='button';
      pager.append(prev,next);
      panel.append(picker,note,grid,pager);
      workBody.replaceChildren(panel);
      dynamic.push(picker);
      prev.addEventListener('click',()=>{if(!parentBusy&&!applying&&page>0){page--;paint();}});
      next.addEventListener('click',()=>{
        const table=tables[tableIndex];
        const cells=Array.isArray(table&&table.cells)?table.cells:[];
        const rowCount=new Set(cells.map(cell=>cell&&cell.row)).size;
        if(!parentBusy&&!applying&&(page+1)*ROW_PAGE<rowCount){page++;paint();}
      });
      paint();
      function paint(){
        const table=tables[tableIndex];
        const cells=Array.isArray(table&&table.cells)?table.cells.filter(cell=>cell&&typeof cell.text==='string'&&Number.isSafeInteger(cell.row)&&Number.isSafeInteger(cell.column)):[];
        const rows=[...new Set(cells.map(cell=>cell.row))].sort((a,b)=>a-b);
        if(page*ROW_PAGE>=rows.length)page=0;
        const shown=new Set(rows.slice(page*ROW_PAGE,(page+1)*ROW_PAGE));
        let missing=0;
        const body=el('tbody');
        for(const cell of cells.filter(entry=>shown.has(entry.row))){
          const box=cellSourceBox(cell,analysis);
          if(!box)missing++;
          const key=analysis.analysisId+'\n'+tableIndex+'\n'+cell.row+'\n'+cell.column;
          const existing=regionOps.get(key);
          const row=el('tr');
          row.append(el('th',null,String(cell.row+1)));
          const td=el('td');
          const label=el('label');
          label.append(el('span','muted','이전 '+cell.text));
          const input=el('input');
          input.value=existing&&existing.record?existing.record.after:cell.text;
          input.disabled=!box;
          input._softLock=!box;
          input.setAttribute('aria-label','스캔 행 '+(cell.row+1)+' 열 '+(cell.column+1));
          input.addEventListener('input',()=>{if(!box||parentBusy||applying)return;void commitOcr(analysis,tableIndex,cell,box,input.value);});
          label.append(input);
          td.append(label);
          row.append(td);
          body.append(row);
          dynamic.push(input);
        }
        const tableEl=el('table');
        tableEl.append(body);
        grid.replaceChildren(tableEl);
        say(note,missing?TEXT.ocrBox:'');
        syncDisabled();
      }
    }
    async function commitOcr(analysis,tableIndex,cell,box,after){
      const key=analysis.analysisId+'\n'+tableIndex+'\n'+cell.row+'\n'+cell.column;
      if(after===cell.text){regionOps.delete(key);emit();syncDisabled();say(compare,'');return;}
      const token=generation;
      try{
        const rendered=await renderRegion(analysis.pageIndex,box);
        if(token!==generation)return;
        if(!rendered)throw err('region');
        const image=await decodePng(rendered.bytes);
        const png=await rasterText(image,after,{x:2,y:2},'cell',doc);
        const sha=await digest(png);
        const id='ocr-'+analysis.analysisId+'-'+tableIndex+'-'+cell.row+'-'+cell.column;
        regionOps.set(key,{
          wire:{id,kind:'region',assetKind:'figure',pageIndex:analysis.pageIndex,bbox:box.slice(),beforeImageSha256:rendered.sha256,png:encodeB64(png)},
          record:{id,kind:'region',assetKind:'figure',pageIndex:analysis.pageIndex,bbox:box.slice(),before:cell.text,after,author:'human'}
        });
        setImages(rendered.bytes,png);
        say(compare,'이전 '+cell.text+'\n이후 '+after);
        emit();
        syncDisabled();
      }catch(error){
        if(token!==generation)return;
        say(status,TEXT[codeOf(error)]||TEXT.region,true);
        errorCode=codeOf(error);
      }
    }
    async function refreshRegionHashes(token,src){
      for(const entry of [...regionOps.values()]){
        const wire=entry.wire;
        const rendered=await renderRegion(wire.pageIndex,wire.bbox);
        if(!live(token,src))throw err('stale');
        if(!rendered||rendered.sha256!==wire.beforeImageSha256)throw err('stale');
      }
    }
    async function verifyExport(data,fileHash,revision){
      if(!data||data.schema!==EXPORT_SCHEMA||data.sourceSha256!==fileHash||typeof data.outputSha256!=='string'||!HEX.test(data.outputSha256))return null;
      const bytes=decodeB64(data.file);
      if(!isPdf(bytes))return null;
      const hash=await digest(bytes);
      if(hash!==data.outputSha256)return null;
      if(!Number.isSafeInteger(data.pageCount)||data.pageCount<1||data.pageCount>20000)return null;
      const verification=data.verification;
      if(!verification||(verification.status!=='passed'&&verification.status!=='warning')||!Array.isArray(verification.issues)||verification.issues.some(item=>typeof item!=='string'&&!(item&&typeof item.code==='string')))return null;
      if(!Array.isArray(data.changes))return null;
      let changes;
      try{changes=root.structuredClone(data.changes);}catch{return null;}
      return {bytes,hash,source:fileHash,revision,changes,verification:root.structuredClone(verification),pageCount:data.pageCount};
    }
    async function apply(){
      if(parentBusy||applying)return;
      const src=currentSource();
      if(!src||src.fileHash!==boundHash||src.revision!==boundRevision||!paperId){say(status,TEXT.stale,true);errorCode='stale';return;}
      await imageTask;
      if(figureState)await composeFigure();
      if(chartState&&editorDirty(chartState))await flushChart(generation);
      if(chartBlocked){say(status,TEXT.chartInvalid,true);errorCode='invalid';return;}
      const ops=wires();
      if(!ops.length){say(status,TEXT.applyNone,true);errorCode='none';return;}
      if(ops.length>MAX_OPS){say(status,TEXT.applyMax,true);errorCode='max';return;}
      applying=true;
      syncDisabled();
      const token=generation;
      let locked=false;
      try{
        if(typeof hold==='function'){
          locked=true;
          const ok=await hold({active:true,phase:'apply'});
          if(ok===false){say(status,TEXT.hold,true);errorCode='hold';return;}
        }
        if(!live(token,src)){say(status,TEXT.stale,true);errorCode='stale';return;}
        await refreshRegionHashes(token,src);
        const signal=track();
        const response=await session().request(EXPORT,{schema:REQUEST_SCHEMA,paperId,fileHash:src.fileHash,revision:src.revision,operations:wires()},{signal});
        if(!live(token,src)){say(status,TEXT.stale,true);errorCode='stale';return;}
        const verified=await verifyExport(response,src.fileHash,src.revision);
        if(!verified){say(status,TEXT.applyFail,true);errorCode='failed';return;}
        output=verified;
        output.draftKey=JSON.stringify(records());
        paintOutput();
        say(status,TEXT.applyOk);
        errorCode=null;
        try{await deliver();}
        catch{say(status,TEXT.handoff,true);errorCode='handoff';}
      }catch(error){
        if(error?.name==='AbortError'||!live(token,src)){say(status,TEXT.stale,true);errorCode='stale';return;}
        say(status,TEXT.applyFail,true);
        errorCode=codeOf(error)==='stale'?'stale':'failed';
      }finally{
        applying=false;
        if(locked&&typeof hold==='function'){try{await hold({active:false,phase:'apply'});}catch{}}
        syncDisabled();
      }
    }
    async function loadSource(token,src,signal){
      try{
        retry.hidden=true;
        say(status,TEXT.preparing);
        if(typeof src.file.size==='number'&&src.file.size>MAX_PDF)throw err('limit');
        const raw=await src.file.arrayBuffer();
        if(!liveReady(token))return;
        const bytes=raw instanceof Uint8Array?new Uint8Array(raw):new Uint8Array(raw);
        if(bytes.length>MAX_PDF)throw err('limit');
        if(typeof src.file.size==='number'&&src.file.size!==bytes.length)throw err('hash');
        if(!isPdf(bytes))throw err('notPdf');
        const actual=await digest(bytes);
        if(!liveReady(token))return;
        if(actual!==src.fileHash)throw err('hash');
        const summary=await session().request(PREPARE,{fileHash:src.fileHash,file:encodeB64(bytes)},{signal});
        if(!liveReady(token))return;
        const parsed=validateSummary(summary,src.fileHash);
        if(!parsed)throw err('failed');
        paperId=parsed.paperId;
        boundHash=src.fileHash;
        boundRevision=src.revision;
        pageCount=parsed.pageCount;
        const listed=await session().request(QUERY,{paperId,operation:'list',offset:0,limit:LIST_PAGE},{signal});
        const analyses=await session().request(QUERY,{paperId,operation:'analyses'},{signal});
        if(!live(token,src))return;
        const page=validateList(listed,paperId,src.fileHash,0);
        const savedPageItems=validateAnalyses(analyses,paperId,src.fileHash);
        if(!page||!savedPageItems)throw err('listFailed');
        listItems=page.items;
        listTotal=page.total;
        listPage=0;
        savedItems=savedPageItems;
        savedPage=0;
        paintLists();
        say(status,'표와 그림 '+listTotal+'개 · 저장된 항목 '+savedItems.length+'개');
        errorCode=null;
      }catch(error){
        if(error?.name==='AbortError'||token!==generation)return;
        const code=codeOf(error);
        errorCode=code;
        say(status,TEXT[code]||TEXT.failed,true);
        retry.hidden=false;
      }finally{syncDisabled();}
      function liveReady(current){return current===generation;}
    }
    function refresh(){
      const src=currentSource();
      if(!src){
        const probed=(()=>{try{return getSource();}catch{return {bad:true};}})();
        bump();
        flight=null;
        paperId=null;boundHash=null;boundRevision=null;
        resetDrafts();
        listItems=[];listTotal=0;listPage=0;savedItems=[];savedPage=0;
        paintLists();
        say(status,probed&&probed.file?TEXT.hash:TEXT.need,!!(probed&&probed.file));
        errorCode=probed&&probed.file?'hash':null;
        retry.hidden=true;
        paintOutput();
        return Promise.resolve(snapshot());
      }
      if(paperId&&src.fileHash===boundHash&&src.revision===boundRevision)return Promise.resolve(snapshot());
      const key=src.fileHash+'\n'+src.revision;
      if(flight&&flight.key===key)return flight.promise;
      const token=bump();
      resetDrafts();
      paperId=null;boundHash=null;boundRevision=null;
      listItems=[];listTotal=0;savedItems=[];
      paintLists();
      paintOutput();
      const signal=track();
      const promise=loadSource(token,src,signal).finally(()=>{if(flight&&flight.token===token)flight=null;});
      flight={key,token,promise};
      return promise;
    }
    function clear(){
      bump();
      flight=null;
      parentBusy=false;
      applying=false;
      paperId=null;boundHash=null;boundRevision=null;
      resetDrafts();
      listItems=[];listTotal=0;listPage=0;savedItems=[];savedPage=0;
      if(downloadUrl){try{root.URL.revokeObjectURL(downloadUrl);}catch{}downloadUrl=null;}
      output=null;
      errorCode=null;
      paintLists();
      paintOutput();
      say(status,TEXT.need);
      retry.hidden=true;
      syncDisabled();
    }
    async function setAnalysis(result){
      const src=currentSource();
      if(!src||result?.fileHash!==src.fileHash||!idOk(result.analysisId))return;
      if(!paperId)await refresh();
      if(result.paperId!==paperId||result.fileHash!==boundHash)return;
      analysisCache.set(result.analysisId,result);
      if(!savedItems.some(x=>x.analysisId===result.analysisId))savedItems.push({analysisId:result.analysisId,kind:result.kind,pageIndex:result.pageIndex,bbox:result.bbox});
      paintLists();
      if(result.kind==='chart'&&!result.data?.rows?.length)return;
      await select('analysis:'+result.analysisId);
    }
    function setBusy(value){parentBusy=!!value;syncDisabled();}
    function snapshot(){
      const src=currentSource();
      return Object.freeze({
        schema:'falsify.visual-edit-ui.v1',
        busy:parentBusy,
        applying,
        fileHash:src?src.fileHash:null,
        revision:src?src.revision:null,
        paperId,
        selected:selectedKey,
        pending:pendingCount(),
        outputFileHash:output?output.hash:null,
        outputSourceHash:output?output.source:null,
        error:errorCode
      });
    }
    applyBtn.addEventListener('click',()=>{void apply();});
    blueBtn.addEventListener('click',()=>{void deliver('blue').catch(()=>{say(status,TEXT.handoff,true);errorCode='handoff';});});
    retry.addEventListener('click',()=>{if(!parentBusy&&!applying)void refresh();});
    listPrev.addEventListener('click',()=>{if(listPage>0&&paperId)void loadList(generation,currentSource(),listPage-1);});
    listNext.addEventListener('click',()=>{if((listPage+1)*LIST_PAGE<listTotal&&paperId)void loadList(generation,currentSource(),listPage+1);});
    savedPrev.addEventListener('click',()=>{if(savedPage>0){savedPage--;paintLists();}});
    savedNext.addEventListener('click',()=>{if((savedPage+1)*LIST_PAGE<savedItems.length){savedPage++;paintLists();}});
    syncDisabled();
    return Object.freeze({setBusy,refresh,clear,snapshot,setAnalysis,setOcrAnalysis:setAnalysis});
  }

  const api=Object.freeze({create});
  root.FalsifyVisualEditUI=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis==='object'?globalThis:this);
