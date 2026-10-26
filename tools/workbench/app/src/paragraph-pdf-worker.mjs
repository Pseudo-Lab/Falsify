import {inspectPage, prepare} from './paragraph-pdf.mjs';
self.onmessage = async ({data}) => {
  const {id, operation, bytes, ...request} = data;
  try {
    if (operation !== 'inspectPage' && operation !== 'prepare') throw new Error('Unknown operation');
    const result = await (operation === 'inspectPage' ? inspectPage : prepare)({...request, file: {name: request.name, bytes: new Uint8Array(bytes)}});
    if (operation === 'prepare') {
      const output = await result.file.arrayBuffer();
      self.postMessage({id, ok: true, result: {...result, file: undefined}, name: result.file.name, bytes: output}, [output]);
    } else self.postMessage({id, ok: true, result});
  } catch (error) {
    self.postMessage({id, ok: false, error: {message: error.message, code: error.code || 'engine', details: error.details || {}, report: error.report}});
  }
};
