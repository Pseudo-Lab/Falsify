"""Synthetic Codex command: reads only its test PNG and emits a fixed observation."""
import hashlib, json, os, pathlib, sys
if sys.argv[1:3] == ['login','status']:
    print('Logged in using ChatGPT'); raise SystemExit(0)
assert sys.argv[1] == 'exec'
paths=[sys.argv[i+1] for i,a in enumerate(sys.argv) if a=='--image']
assert len(paths)==1
image=pathlib.Path(paths[0]).read_bytes()
pathlib.Path(os.environ['BLUE_FAKE_LOG']).write_text(json.dumps({'paths':paths,'sha256':hashlib.sha256(image).hexdigest()}))
prompt=sys.stdin.read(); marker='Supplemental images in order, identified by these references: '
refs,_=json.JSONDecoder().raw_decode(prompt.split(marker,1)[1]); ref=refs[0]
if os.environ.get('BLUE_BAD_REF')=='1': ref['sha256']='b'*64
response={'status':'ok','findings':[],'visualObservations':[{'id':'v1','sha256':ref['sha256'],'page':ref['page'],'bbox':ref['bbox'],'observation':'Synthetic figure.','uncertainty':'Unverified.'}]}
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':json.dumps(response)}}))
print(json.dumps({'type':'turn.completed','usage':{}}))
