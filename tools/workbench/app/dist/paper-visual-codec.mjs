// Pure baseline JPEG decoder extracted from the visual editor.
const MAX_PIXELS=4000000;
function err(code){const error=new Error(code);error.code=code;return error;}
function isJpeg(bytes){return bytes&&bytes.length>=3&&bytes[0]===0xFF&&bytes[1]===0xD8&&bytes[2]===0xFF;}
  const ZIGZAG=[
    0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,
    35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63
  ];
  const COS=new Float64Array(64);
  for(let u=0;u<8;u++)for(let x=0;x<8;x++)COS[u*8+x]=Math.cos(((2*x+1)*u*Math.PI)/16);
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
  export async function decodeJpeg(bytes){
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
      if(mark===0xDA)return readScan();
      const length=readU16();
      const end=offset+length-2;
      if(end>bytes.length)throw err('jpeg');
      if(mark===0xC0)readFrame();
      else if(mark===0xC2||mark===0xC1||mark===0xC3)throw err('jpeg');
      else if(mark===0xDB)readQuant(end);
      else if(mark===0xC4)readHuffman(end);
      else if(mark===0xDD)restart=(bytes[offset]<<8)|bytes[offset+1];
      offset=end;
    }
    throw err('jpeg');
    function readScan(){
        const length=readU16();
        const start=offset;
        const count=bytes[offset++];
        const scan=[];
        for(let i=0;i<count;i++){const id=bytes[offset++],table=bytes[offset++];scan.push({id,dc:table>>4,ac:table&15});}
        const ss=bytes[offset++],se=bytes[offset++],ah=bytes[offset++];
        if(ss!==0||se!==63||ah!==0||offset!==start+length-2)throw err('jpeg');
        return decodeScan(bytes,offset,frame,quant,huff,scan,restart);
    }
    function readFrame(){
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
    }
    function readQuant(end){
        while(offset<end){
          const id=bytes[offset++];
          if((id>>4)!==0||(id&15)>3)throw err('jpeg');
          const table=new Float64Array(64);
          for(let i=0;i<64;i++)table[ZIGZAG[i]]=bytes[offset++];
          quant[id&15]=table;
        }
    }
    function readHuffman(end){
        while(offset<end){
          const id=bytes[offset++];
          const counts=[];let total=0;
          for(let i=0;i<16;i++){counts.push(bytes[offset++]);total+=counts[i];}
          const symbols=[];
          for(let i=0;i<total;i++)symbols.push(bytes[offset++]);
          const table=buildHuff(counts,symbols);
          ((id>>4)?huff.ac:huff.dc)[id&15]=table;
        }
    }
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
      const planes=decodePlanes();
      paintMcu(planes,mx,my);
    }
    function decodePlanes(){
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

      return planes;
    }
    function paintMcu(planes,mx,my){
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
