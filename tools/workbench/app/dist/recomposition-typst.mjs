var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../../../recomposition-20261027/typesetter/.local/spike/node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs
function addHeapObject(obj) {
  if (heap_next === heap.length) heap.push(heap.length + 1);
  const idx = heap_next;
  heap_next = heap[idx];
  heap[idx] = obj;
  return idx;
}
function _assertClass(instance, klass) {
  if (!(instance instanceof klass)) {
    throw new Error(`expected instance of ${klass.name}`);
  }
}
function debugString(val) {
  const type = typeof val;
  if (type == "number" || type == "boolean" || val == null) {
    return `${val}`;
  }
  if (type == "string") {
    return `"${val}"`;
  }
  if (type == "symbol") {
    const description = val.description;
    if (description == null) {
      return "Symbol";
    } else {
      return `Symbol(${description})`;
    }
  }
  if (type == "function") {
    const name = val.name;
    if (typeof name == "string" && name.length > 0) {
      return `Function(${name})`;
    } else {
      return "Function";
    }
  }
  if (Array.isArray(val)) {
    const length = val.length;
    let debug = "[";
    if (length > 0) {
      debug += debugString(val[0]);
    }
    for (let i = 1; i < length; i++) {
      debug += ", " + debugString(val[i]);
    }
    debug += "]";
    return debug;
  }
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
  let className;
  if (builtInMatches && builtInMatches.length > 1) {
    className = builtInMatches[1];
  } else {
    return toString.call(val);
  }
  if (className == "Object") {
    try {
      return "Object(" + JSON.stringify(val) + ")";
    } catch (_) {
      return "Object";
    }
  }
  if (val instanceof Error) {
    return `${val.name}: ${val.message}
${val.stack}`;
  }
  return className;
}
function dropObject(idx) {
  if (idx < 132) return;
  heap[idx] = heap_next;
  heap_next = idx;
}
function getArrayJsValueFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  const mem = getDataViewMemory0();
  const result = [];
  for (let i = ptr; i < ptr + 4 * len; i += 4) {
    result.push(takeObject(mem.getUint32(i, true)));
  }
  return result;
}
function getArrayU32FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}
function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(ptr, len);
}
function getUint32ArrayMemory0() {
  if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
    cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
  }
  return cachedUint32ArrayMemory0;
}
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
function getObject(idx) {
  return heap[idx];
}
function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    wasm.__wbindgen_export3(addHeapObject(e));
  }
}
function isLikeNone(x) {
  return x === void 0 || x === null;
}
function makeMutClosure(arg0, arg1, dtor, f) {
  const state = { a: arg0, b: arg1, cnt: 1, dtor };
  const real = (...args) => {
    state.cnt++;
    const a = state.a;
    state.a = 0;
    try {
      return f(a, state.b, ...args);
    } finally {
      state.a = a;
      real._wbg_cb_unref();
    }
  };
  real._wbg_cb_unref = () => {
    if (--state.cnt === 0) {
      state.dtor(state.a, state.b);
      state.a = 0;
      CLOSURE_DTORS.unregister(state);
    }
  };
  CLOSURE_DTORS.register(real, state, state);
  return real;
}
function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function passArrayJsValueToWasm0(array, malloc) {
  const ptr = malloc(array.length * 4, 4) >>> 0;
  const mem = getDataViewMemory0();
  for (let i = 0; i < array.length; i++) {
    mem.setUint32(ptr + 4 * i, addHeapObject(array[i]), true);
  }
  WASM_VECTOR_LEN = array.length;
  return ptr;
}
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === void 0) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = getUint8ArrayMemory0();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);
    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}
function takeObject(idx) {
  const ret = getObject(idx);
  dropObject(idx);
  return ret;
}
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
function __wasm_bindgen_func_elem_944(arg0, arg1, arg2) {
  wasm.__wasm_bindgen_func_elem_944(arg0, arg1, addHeapObject(arg2));
}
function __wasm_bindgen_func_elem_37350(arg0, arg1, arg2, arg3) {
  wasm.__wasm_bindgen_func_elem_37350(arg0, arg1, addHeapObject(arg2), addHeapObject(arg3));
}
function get_font_info(buffer) {
  const ret = wasm.get_font_info(addHeapObject(buffer));
  return takeObject(ret);
}
async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);
        if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }
}
function __wbg_get_imports() {
  const imports = {};
  imports.wbg = {};
  imports.wbg.__wbg_Error_52673b7de5a0ca89 = function(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_Number_2d1dcfcf4ec51736 = function(arg0) {
    const ret = Number(getObject(arg0));
    return ret;
  };
  imports.wbg.__wbg___wbindgen_bigint_get_as_i64_6e32f5e6aff02e1d = function(arg0, arg1) {
    const v = getObject(arg1);
    const ret = typeof v === "bigint" ? v : void 0;
    getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
  };
  imports.wbg.__wbg___wbindgen_boolean_get_dea25b33882b895b = function(arg0) {
    const v = getObject(arg0);
    const ret = typeof v === "boolean" ? v : void 0;
    return isLikeNone(ret) ? 16777215 : ret ? 1 : 0;
  };
  imports.wbg.__wbg___wbindgen_debug_string_adfb662ae34724b6 = function(arg0, arg1) {
    const ret = debugString(getObject(arg1));
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg___wbindgen_in_0d3e1e8f0c669317 = function(arg0, arg1) {
    const ret = getObject(arg0) in getObject(arg1);
    return ret;
  };
  imports.wbg.__wbg___wbindgen_is_bigint_0e1a2e3f55cfae27 = function(arg0) {
    const ret = typeof getObject(arg0) === "bigint";
    return ret;
  };
  imports.wbg.__wbg___wbindgen_is_function_8d400b8b1af978cd = function(arg0) {
    const ret = typeof getObject(arg0) === "function";
    return ret;
  };
  imports.wbg.__wbg___wbindgen_is_object_ce774f3490692386 = function(arg0) {
    const val = getObject(arg0);
    const ret = typeof val === "object" && val !== null;
    return ret;
  };
  imports.wbg.__wbg___wbindgen_is_string_704ef9c8fc131030 = function(arg0) {
    const ret = typeof getObject(arg0) === "string";
    return ret;
  };
  imports.wbg.__wbg___wbindgen_is_undefined_f6b95eab589e0269 = function(arg0) {
    const ret = getObject(arg0) === void 0;
    return ret;
  };
  imports.wbg.__wbg___wbindgen_jsval_eq_b6101cc9cef1fe36 = function(arg0, arg1) {
    const ret = getObject(arg0) === getObject(arg1);
    return ret;
  };
  imports.wbg.__wbg___wbindgen_jsval_loose_eq_766057600fdd1b0d = function(arg0, arg1) {
    const ret = getObject(arg0) == getObject(arg1);
    return ret;
  };
  imports.wbg.__wbg___wbindgen_number_get_9619185a74197f95 = function(arg0, arg1) {
    const obj = getObject(arg1);
    const ret = typeof obj === "number" ? obj : void 0;
    getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
  };
  imports.wbg.__wbg___wbindgen_string_get_a2a31e16edf96e42 = function(arg0, arg1) {
    const obj = getObject(arg1);
    const ret = typeof obj === "string" ? obj : void 0;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
  };
  imports.wbg.__wbg__wbg_cb_unref_87dfb5aaa0cbcea7 = function(arg0) {
    getObject(arg0)._wbg_cb_unref();
  };
  imports.wbg.__wbg_call_3020136f7a2d6e44 = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));
      return addHeapObject(ret);
    }, arguments);
  };
  imports.wbg.__wbg_call_78f94eb02ec7f9b2 = function() {
    return handleError(function(arg0, arg1, arg2, arg3, arg4) {
      const ret = getObject(arg0).call(getObject(arg1), getObject(arg2), getObject(arg3), getObject(arg4));
      return addHeapObject(ret);
    }, arguments);
  };
  imports.wbg.__wbg_call_abb4ff46ce38be40 = function() {
    return handleError(function(arg0, arg1) {
      const ret = getObject(arg0).call(getObject(arg1));
      return addHeapObject(ret);
    }, arguments);
  };
  imports.wbg.__wbg_done_62ea16af4ce34b24 = function(arg0) {
    const ret = getObject(arg0).done;
    return ret;
  };
  imports.wbg.__wbg_entries_83c79938054e065f = function(arg0) {
    const ret = Object.entries(getObject(arg0));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
      deferred0_0 = arg0;
      deferred0_1 = arg1;
      console.error(getStringFromWasm0(arg0, arg1));
    } finally {
      wasm.__wbindgen_export4(deferred0_0, deferred0_1, 1);
    }
  };
  imports.wbg.__wbg_error_85faeb8919b11cc6 = function(arg0, arg1, arg2) {
    console.error(getObject(arg0), getObject(arg1), getObject(arg2));
  };
  imports.wbg.__wbg_getTimezoneOffset_45389e26d6f46823 = function(arg0) {
    const ret = getObject(arg0).getTimezoneOffset();
    return ret;
  };
  imports.wbg.__wbg_get_6b7bd52aca3f9671 = function(arg0, arg1) {
    const ret = getObject(arg0)[arg1 >>> 0];
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_get_af9dab7e9603ea93 = function() {
    return handleError(function(arg0, arg1) {
      const ret = Reflect.get(getObject(arg0), getObject(arg1));
      return addHeapObject(ret);
    }, arguments);
  };
  imports.wbg.__wbg_get_with_ref_key_1dc361bd10053bfe = function(arg0, arg1) {
    const ret = getObject(arg0)[getObject(arg1)];
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_info_ce6bcc489c22f6f0 = function(arg0) {
    console.info(getObject(arg0));
  };
  imports.wbg.__wbg_instanceof_ArrayBuffer_f3320d2419cd0355 = function(arg0) {
    let result;
    try {
      result = getObject(arg0) instanceof ArrayBuffer;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Map_084be8da74364158 = function(arg0) {
    let result;
    try {
      result = getObject(arg0) instanceof Map;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Uint8Array_da54ccc9d3e09434 = function(arg0) {
    let result;
    try {
      result = getObject(arg0) instanceof Uint8Array;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_isArray_51fd9e6422c0a395 = function(arg0) {
    const ret = Array.isArray(getObject(arg0));
    return ret;
  };
  imports.wbg.__wbg_isSafeInteger_ae7d3f054d55fa16 = function(arg0) {
    const ret = Number.isSafeInteger(getObject(arg0));
    return ret;
  };
  imports.wbg.__wbg_iterator_27b7c8b35ab3e86b = function() {
    const ret = Symbol.iterator;
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_length_22ac23eaec9d8053 = function(arg0) {
    const ret = getObject(arg0).length;
    return ret;
  };
  imports.wbg.__wbg_length_d45040a40c570362 = function(arg0) {
    const ret = getObject(arg0).length;
    return ret;
  };
  imports.wbg.__wbg_new_1ba21ce319a06297 = function() {
    const ret = new Object();
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_new_25f239778d6112b9 = function() {
    const ret = new Array();
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_new_6421f6084cc5bc5a = function(arg0) {
    const ret = new Uint8Array(getObject(arg0));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
    const ret = new Error();
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_new_b2db8aa2650f793a = function(arg0) {
    const ret = new Date(getObject(arg0));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_new_df1173567d5ff028 = function(arg0, arg1) {
    const ret = new Error(getStringFromWasm0(arg0, arg1));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_new_ff12d2b041fb48f1 = function(arg0, arg1) {
    try {
      var state0 = { a: arg0, b: arg1 };
      var cb0 = (arg02, arg12) => {
        const a = state0.a;
        state0.a = 0;
        try {
          return __wasm_bindgen_func_elem_37350(a, state0.b, arg02, arg12);
        } finally {
          state0.a = a;
        }
      };
      const ret = new Promise(cb0);
      return addHeapObject(ret);
    } finally {
      state0.a = state0.b = 0;
    }
  };
  imports.wbg.__wbg_new_from_slice_db0691b69e9d3891 = function(arg0, arg1) {
    const ret = new Uint32Array(getArrayU32FromWasm0(arg0, arg1));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_new_from_slice_f9c22b9153b26992 = function(arg0, arg1) {
    const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_new_no_args_cb138f77cf6151ee = function(arg0, arg1) {
    const ret = new Function(getStringFromWasm0(arg0, arg1));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_new_with_args_df9e7125ffe55248 = function(arg0, arg1, arg2, arg3) {
    const ret = new Function(getStringFromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_next_138a17bbf04e926c = function(arg0) {
    const ret = getObject(arg0).next;
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_next_3cfe5c0fe2a4cc53 = function() {
    return handleError(function(arg0) {
      const ret = getObject(arg0).next();
      return addHeapObject(ret);
    }, arguments);
  };
  imports.wbg.__wbg_now_69d776cd24f5215b = function() {
    const ret = Date.now();
    return ret;
  };
  imports.wbg.__wbg_prototypesetcall_dfe9b766cdc1f1fd = function(arg0, arg1, arg2) {
    Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), getObject(arg2));
  };
  imports.wbg.__wbg_proxycontext_new = function(arg0) {
    const ret = ProxyContext.__wrap(arg0);
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_push_7d9be8f38fc13975 = function(arg0, arg1) {
    const ret = getObject(arg0).push(getObject(arg1));
    return ret;
  };
  imports.wbg.__wbg_queueMicrotask_9b549dfce8865860 = function(arg0) {
    const ret = getObject(arg0).queueMicrotask;
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_queueMicrotask_fca69f5bfad613a5 = function(arg0) {
    queueMicrotask(getObject(arg0));
  };
  imports.wbg.__wbg_resolve_fd5bfbaa4ce36e1e = function(arg0) {
    const ret = Promise.resolve(getObject(arg0));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
    getObject(arg0)[takeObject(arg1)] = takeObject(arg2);
  };
  imports.wbg.__wbg_set_781438a03c0c3c81 = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = Reflect.set(getObject(arg0), getObject(arg1), getObject(arg2));
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_set_7df433eea03a5c14 = function(arg0, arg1, arg2) {
    getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
  };
  imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
    const ret = getObject(arg1).stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg_static_accessor_GLOBAL_769e6b65d6557335 = function() {
    const ret = typeof global === "undefined" ? null : global;
    return isLikeNone(ret) ? 0 : addHeapObject(ret);
  };
  imports.wbg.__wbg_static_accessor_GLOBAL_THIS_60cf02db4de8e1c1 = function() {
    const ret = typeof globalThis === "undefined" ? null : globalThis;
    return isLikeNone(ret) ? 0 : addHeapObject(ret);
  };
  imports.wbg.__wbg_static_accessor_SELF_08f5a74c69739274 = function() {
    const ret = typeof self === "undefined" ? null : self;
    return isLikeNone(ret) ? 0 : addHeapObject(ret);
  };
  imports.wbg.__wbg_static_accessor_WINDOW_a8924b26aa92d024 = function() {
    const ret = typeof window === "undefined" ? null : window;
    return isLikeNone(ret) ? 0 : addHeapObject(ret);
  };
  imports.wbg.__wbg_then_4f95312d68691235 = function(arg0, arg1) {
    const ret = getObject(arg0).then(getObject(arg1));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_typstcompiler_new = function(arg0) {
    const ret = TypstCompiler.__wrap(arg0);
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_typstfontresolver_new = function(arg0) {
    const ret = TypstFontResolver.__wrap(arg0);
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_value_57b7b035e117f7ee = function(arg0) {
    const ret = getObject(arg0).value;
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_cast_3334ea73b4b28ba3 = function(arg0, arg1) {
    const ret = makeMutClosure(arg0, arg1, wasm.__wasm_bindgen_func_elem_957, __wasm_bindgen_func_elem_944);
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_cast_4625c577ab2ec9ee = function(arg0) {
    const ret = BigInt.asUintN(64, arg0);
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_cast_9ae0607507abb057 = function(arg0) {
    const ret = arg0;
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_cast_d6cd19b81560fd6e = function(arg0) {
    const ret = arg0;
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_object_clone_ref = function(arg0) {
    const ret = getObject(arg0);
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_object_drop_ref = function(arg0) {
    takeObject(arg0);
  };
  return imports;
}
function __wbg_finalize_init(instance, module) {
  wasm = instance.exports;
  __wbg_init.__wbindgen_wasm_module = module;
  cachedDataViewMemory0 = null;
  cachedUint32ArrayMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  return wasm;
}
function initSync(module) {
  if (wasm !== void 0) return wasm;
  if (typeof module !== "undefined") {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ({ module } = module);
    } else {
      console.warn("using deprecated parameters for `initSync()`; pass a single object instead");
    }
  }
  const imports = __wbg_get_imports();
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module);
  }
  const instance = new WebAssembly.Instance(module, imports);
  return __wbg_finalize_init(instance, module);
}
async function __wbg_init(module_or_path) {
  if (wasm !== void 0) return wasm;
  if (typeof module_or_path !== "undefined") {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn("using deprecated parameters for the initialization function; pass a single object instead");
    }
  }
  if (typeof module_or_path === "undefined") {
    module_or_path = importWasmModule("typst_ts_web_compiler_bg.wasm", import.meta.url);
  }
  const imports = __wbg_get_imports();
  if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {
    module_or_path = fetch(module_or_path);
  }
  const { instance, module } = await __wbg_load(await module_or_path, imports);
  return __wbg_finalize_init(instance, module);
}
function setImportWasmModule(importer) {
  importWasmModule = importer;
}
var wasm, CLOSURE_DTORS, cachedDataViewMemory0, cachedUint32ArrayMemory0, cachedUint8ArrayMemory0, heap, heap_next, cachedTextDecoder, MAX_SAFARI_DECODE_BYTES, numBytesDecoded, cachedTextEncoder, WASM_VECTOR_LEN, IncrServerFinalization, ProxyContextFinalization, TypstCompileWorldFinalization, TypstCompilerFinalization, TypstCompilerBuilderFinalization, TypstFontResolverFinalization, TypstFontResolverBuilderFinalization, IncrServer, ProxyContext, TypstCompileWorld, TypstCompiler, TypstCompilerBuilder, TypstFontResolver, TypstFontResolverBuilder, EXPECTED_RESPONSE_TYPES, typst_ts_web_compiler_default, importWasmModule;
var init_typst_ts_web_compiler = __esm({
  "../../../recomposition-20261027/typesetter/.local/spike/node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs"() {
    CLOSURE_DTORS = typeof FinalizationRegistry === "undefined" ? { register: () => {
    }, unregister: () => {
    } } : new FinalizationRegistry((state) => state.dtor(state.a, state.b));
    cachedDataViewMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    heap = new Array(128).fill(void 0);
    heap.push(void 0, null, true, false);
    heap_next = heap.length;
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    MAX_SAFARI_DECODE_BYTES = 2146435072;
    numBytesDecoded = 0;
    cachedTextEncoder = new TextEncoder();
    if (!("encodeInto" in cachedTextEncoder)) {
      cachedTextEncoder.encodeInto = function(arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
          read: arg.length,
          written: buf.length
        };
      };
    }
    WASM_VECTOR_LEN = 0;
    IncrServerFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
    }, unregister: () => {
    } } : new FinalizationRegistry((ptr) => wasm.__wbg_incrserver_free(ptr >>> 0, 1));
    ProxyContextFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
    }, unregister: () => {
    } } : new FinalizationRegistry((ptr) => wasm.__wbg_proxycontext_free(ptr >>> 0, 1));
    TypstCompileWorldFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
    }, unregister: () => {
    } } : new FinalizationRegistry((ptr) => wasm.__wbg_typstcompileworld_free(ptr >>> 0, 1));
    TypstCompilerFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
    }, unregister: () => {
    } } : new FinalizationRegistry((ptr) => wasm.__wbg_typstcompiler_free(ptr >>> 0, 1));
    TypstCompilerBuilderFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
    }, unregister: () => {
    } } : new FinalizationRegistry((ptr) => wasm.__wbg_typstcompilerbuilder_free(ptr >>> 0, 1));
    TypstFontResolverFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
    }, unregister: () => {
    } } : new FinalizationRegistry((ptr) => wasm.__wbg_typstfontresolver_free(ptr >>> 0, 1));
    TypstFontResolverBuilderFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
    }, unregister: () => {
    } } : new FinalizationRegistry((ptr) => wasm.__wbg_typstfontresolverbuilder_free(ptr >>> 0, 1));
    IncrServer = class _IncrServer {
      static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(_IncrServer.prototype);
        obj.__wbg_ptr = ptr;
        IncrServerFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
      }
      __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IncrServerFinalization.unregister(this);
        return ptr;
      }
      free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_incrserver_free(ptr, 0);
      }
      /**
       * @param {boolean} attach
       */
      set_attach_debug_info(attach) {
        wasm.incrserver_set_attach_debug_info(this.__wbg_ptr, attach);
      }
      /**
       * @returns {Uint8Array | undefined}
       */
      current() {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.incrserver_current(retptr, this.__wbg_ptr);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          let v1;
          if (r0 !== 0) {
            v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
          }
          return v1;
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      reset() {
        wasm.incrserver_reset(this.__wbg_ptr);
      }
    };
    if (Symbol.dispose) IncrServer.prototype[Symbol.dispose] = IncrServer.prototype.free;
    ProxyContext = class _ProxyContext {
      static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(_ProxyContext.prototype);
        obj.__wbg_ptr = ptr;
        ProxyContextFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
      }
      __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProxyContextFinalization.unregister(this);
        return ptr;
      }
      free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_proxycontext_free(ptr, 0);
      }
      /**
       * Creates a new `ProxyContext` instance.
       * @param {any} context
       */
      constructor(context) {
        const ret = wasm.proxycontext_new(addHeapObject(context));
        this.__wbg_ptr = ret >>> 0;
        ProxyContextFinalization.register(this, this.__wbg_ptr, this);
        return this;
      }
      /**
       * Returns the JavaScript this.
       * @returns {any}
       */
      get context() {
        const ret = wasm.proxycontext_context(this.__wbg_ptr);
        return takeObject(ret);
      }
      /**
       * A convenience function to untar a tarball and call a callback for each
       * entry.
       * @param {Uint8Array} data
       * @param {Function} cb
       */
      untar(data, cb) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
          const len0 = WASM_VECTOR_LEN;
          wasm.proxycontext_untar(retptr, this.__wbg_ptr, ptr0, len0, addHeapObject(cb));
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          if (r1) {
            throw takeObject(r0);
          }
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
    };
    if (Symbol.dispose) ProxyContext.prototype[Symbol.dispose] = ProxyContext.prototype.free;
    TypstCompileWorld = class _TypstCompileWorld {
      static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(_TypstCompileWorld.prototype);
        obj.__wbg_ptr = ptr;
        TypstCompileWorldFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
      }
      __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TypstCompileWorldFinalization.unregister(this);
        return ptr;
      }
      free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_typstcompileworld_free(ptr, 0);
      }
      /**
       * @param {number} kind
       * @param {number} diagnostics_format
       * @returns {any}
       */
      compile(kind, diagnostics_format) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstcompileworld_compile(retptr, this.__wbg_ptr, kind, diagnostics_format);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          return takeObject(r0);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {number} kind
       * @returns {string | undefined}
       */
      title(kind) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstcompileworld_title(retptr, this.__wbg_ptr, kind);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
          if (r3) {
            throw takeObject(r2);
          }
          let v1;
          if (r0 !== 0) {
            v1 = getStringFromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
          }
          return v1;
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {number} fmt
       * @param {number} diagnostics_format
       * @returns {any}
       */
      get_artifact(fmt, diagnostics_format) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstcompileworld_get_artifact(retptr, this.__wbg_ptr, fmt, diagnostics_format);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          return takeObject(r0);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {number} kind
       * @param {string} selector
       * @param {string | null} [field]
       * @returns {string}
       */
      query(kind, selector, field) {
        let deferred4_0;
        let deferred4_1;
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          const ptr0 = passStringToWasm0(selector, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          const len0 = WASM_VECTOR_LEN;
          var ptr1 = isLikeNone(field) ? 0 : passStringToWasm0(field, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          var len1 = WASM_VECTOR_LEN;
          wasm.typstcompileworld_query(retptr, this.__wbg_ptr, kind, ptr0, len0, ptr1, len1);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
          var ptr3 = r0;
          var len3 = r1;
          if (r3) {
            ptr3 = 0;
            len3 = 0;
            throw takeObject(r2);
          }
          deferred4_0 = ptr3;
          deferred4_1 = len3;
          return getStringFromWasm0(ptr3, len3);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
          wasm.__wbindgen_export4(deferred4_0, deferred4_1, 1);
        }
      }
      /**
       * @param {IncrServer} state
       * @param {number} diagnostics_format
       * @returns {any}
       */
      incr_compile(state, diagnostics_format) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          _assertClass(state, IncrServer);
          wasm.typstcompileworld_incr_compile(retptr, this.__wbg_ptr, state.__wbg_ptr, diagnostics_format);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          return takeObject(r0);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
    };
    if (Symbol.dispose) TypstCompileWorld.prototype[Symbol.dispose] = TypstCompileWorld.prototype.free;
    TypstCompiler = class _TypstCompiler {
      static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(_TypstCompiler.prototype);
        obj.__wbg_ptr = ptr;
        TypstCompilerFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
      }
      __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TypstCompilerFinalization.unregister(this);
        return ptr;
      }
      free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_typstcompiler_free(ptr, 0);
      }
      reset() {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstcompiler_reset(retptr, this.__wbg_ptr);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          if (r1) {
            throw takeObject(r0);
          }
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {TypstFontResolver} fonts
       */
      set_fonts(fonts) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          _assertClass(fonts, TypstFontResolver);
          wasm.typstcompiler_set_fonts(retptr, this.__wbg_ptr, fonts.__wbg_ptr);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          if (r1) {
            throw takeObject(r0);
          }
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {any} inputs
       */
      set_inputs(inputs) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstcompiler_set_inputs(retptr, this.__wbg_ptr, addHeapObject(inputs));
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          if (r1) {
            throw takeObject(r0);
          }
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {string} path
       * @param {string} content
       * @returns {boolean}
       */
      add_source(path, content) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.typstcompiler_add_source(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret !== 0;
      }
      /**
       * @param {string} path
       * @param {Uint8Array} content
       * @returns {boolean}
       */
      map_shadow(path, content) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(content, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.typstcompiler_map_shadow(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret !== 0;
      }
      /**
       * @param {string} path
       * @returns {boolean}
       */
      unmap_shadow(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.typstcompiler_unmap_shadow(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
      }
      reset_shadow() {
        wasm.typstcompiler_reset_shadow(this.__wbg_ptr);
      }
      /**
       * @returns {string[]}
       */
      get_loaded_fonts() {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstcompiler_get_loaded_fonts(retptr, this.__wbg_ptr);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var v1 = getArrayJsValueFromWasm0(r0, r1).slice();
          wasm.__wbindgen_export4(r0, r1 * 4, 4);
          return v1;
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {string} main_file_path
       * @returns {string}
       */
      get_ast(main_file_path) {
        let deferred3_0;
        let deferred3_1;
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          const ptr0 = passStringToWasm0(main_file_path, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          const len0 = WASM_VECTOR_LEN;
          wasm.typstcompiler_get_ast(retptr, this.__wbg_ptr, ptr0, len0);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
          var ptr2 = r0;
          var len2 = r1;
          if (r3) {
            ptr2 = 0;
            len2 = 0;
            throw takeObject(r2);
          }
          deferred3_0 = ptr2;
          deferred3_1 = len2;
          return getStringFromWasm0(ptr2, len2);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
          wasm.__wbindgen_export4(deferred3_0, deferred3_1, 1);
        }
      }
      /**
       * @returns {any}
       */
      get_semantic_token_legend() {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstcompiler_get_semantic_token_legend(retptr, this.__wbg_ptr);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          return takeObject(r0);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {string} offset_encoding
       * @param {string | null} [file_path]
       * @param {string | null} [result_id]
       * @returns {object}
       */
      get_semantic_tokens(offset_encoding, file_path, result_id) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          const ptr0 = passStringToWasm0(offset_encoding, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          const len0 = WASM_VECTOR_LEN;
          var ptr1 = isLikeNone(file_path) ? 0 : passStringToWasm0(file_path, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          var len1 = WASM_VECTOR_LEN;
          var ptr2 = isLikeNone(result_id) ? 0 : passStringToWasm0(result_id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          var len2 = WASM_VECTOR_LEN;
          wasm.typstcompiler_get_semantic_tokens(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          return takeObject(r0);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {string | null} [root]
       * @param {string | null} [main_file_path]
       * @param {(Array<any>)[] | null} [inputs]
       * @returns {TypstCompileWorld}
       */
      snapshot(root, main_file_path, inputs) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          var ptr0 = isLikeNone(root) ? 0 : passStringToWasm0(root, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          var len0 = WASM_VECTOR_LEN;
          var ptr1 = isLikeNone(main_file_path) ? 0 : passStringToWasm0(main_file_path, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          var len1 = WASM_VECTOR_LEN;
          var ptr2 = isLikeNone(inputs) ? 0 : passArrayJsValueToWasm0(inputs, wasm.__wbindgen_export);
          var len2 = WASM_VECTOR_LEN;
          wasm.typstcompiler_snapshot(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          return TypstCompileWorld.__wrap(r0);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {string} fmt
       * @param {number} diagnostics_format
       * @returns {any}
       */
      get_artifact(fmt, diagnostics_format) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          const ptr0 = passStringToWasm0(fmt, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          const len0 = WASM_VECTOR_LEN;
          wasm.typstcompiler_get_artifact(retptr, this.__wbg_ptr, ptr0, len0, diagnostics_format);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          return takeObject(r0);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {string | null | undefined} main_file_path
       * @param {(Array<any>)[] | null | undefined} inputs
       * @param {string} fmt
       * @param {number} diagnostics_format
       * @returns {any}
       */
      compile(main_file_path, inputs, fmt, diagnostics_format) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          var ptr0 = isLikeNone(main_file_path) ? 0 : passStringToWasm0(main_file_path, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          var len0 = WASM_VECTOR_LEN;
          var ptr1 = isLikeNone(inputs) ? 0 : passArrayJsValueToWasm0(inputs, wasm.__wbindgen_export);
          var len1 = WASM_VECTOR_LEN;
          const ptr2 = passStringToWasm0(fmt, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          const len2 = WASM_VECTOR_LEN;
          wasm.typstcompiler_compile(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, diagnostics_format);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          return takeObject(r0);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {string} main_file_path
       * @param {(Array<any>)[] | null | undefined} inputs
       * @param {string} selector
       * @param {string | null} [field]
       * @returns {string}
       */
      query(main_file_path, inputs, selector, field) {
        let deferred6_0;
        let deferred6_1;
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          const ptr0 = passStringToWasm0(main_file_path, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          const len0 = WASM_VECTOR_LEN;
          var ptr1 = isLikeNone(inputs) ? 0 : passArrayJsValueToWasm0(inputs, wasm.__wbindgen_export);
          var len1 = WASM_VECTOR_LEN;
          const ptr2 = passStringToWasm0(selector, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          const len2 = WASM_VECTOR_LEN;
          var ptr3 = isLikeNone(field) ? 0 : passStringToWasm0(field, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          var len3 = WASM_VECTOR_LEN;
          wasm.typstcompiler_query(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
          var ptr5 = r0;
          var len5 = r1;
          if (r3) {
            ptr5 = 0;
            len5 = 0;
            throw takeObject(r2);
          }
          deferred6_0 = ptr5;
          deferred6_1 = len5;
          return getStringFromWasm0(ptr5, len5);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
          wasm.__wbindgen_export4(deferred6_0, deferred6_1, 1);
        }
      }
      /**
       * @returns {IncrServer}
       */
      create_incr_server() {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstcompiler_create_incr_server(retptr, this.__wbg_ptr);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          return IncrServer.__wrap(r0);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {string} main_file_path
       * @param {(Array<any>)[] | null | undefined} inputs
       * @param {IncrServer} state
       * @param {number} diagnostics_format
       * @returns {any}
       */
      incr_compile(main_file_path, inputs, state, diagnostics_format) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          const ptr0 = passStringToWasm0(main_file_path, wasm.__wbindgen_export, wasm.__wbindgen_export2);
          const len0 = WASM_VECTOR_LEN;
          var ptr1 = isLikeNone(inputs) ? 0 : passArrayJsValueToWasm0(inputs, wasm.__wbindgen_export);
          var len1 = WASM_VECTOR_LEN;
          _assertClass(state, IncrServer);
          wasm.typstcompiler_incr_compile(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, state.__wbg_ptr, diagnostics_format);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          return takeObject(r0);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
    };
    if (Symbol.dispose) TypstCompiler.prototype[Symbol.dispose] = TypstCompiler.prototype.free;
    TypstCompilerBuilder = class {
      __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TypstCompilerBuilderFinalization.unregister(this);
        return ptr;
      }
      free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_typstcompilerbuilder_free(ptr, 0);
      }
      constructor() {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstcompilerbuilder_new(retptr);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          this.__wbg_ptr = r0 >>> 0;
          TypstCompilerBuilderFinalization.register(this, this.__wbg_ptr, this);
          return this;
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      set_dummy_access_model() {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstcompilerbuilder_set_dummy_access_model(retptr, this.__wbg_ptr);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          if (r1) {
            throw takeObject(r0);
          }
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {any} context
       * @param {Function} mtime_fn
       * @param {Function} is_file_fn
       * @param {Function} real_path_fn
       * @param {Function} read_all_fn
       * @returns {Promise<void>}
       */
      set_access_model(context, mtime_fn, is_file_fn, real_path_fn, read_all_fn) {
        const ret = wasm.typstcompilerbuilder_set_access_model(this.__wbg_ptr, addHeapObject(context), addHeapObject(mtime_fn), addHeapObject(is_file_fn), addHeapObject(real_path_fn), addHeapObject(read_all_fn));
        return takeObject(ret);
      }
      /**
       * @param {any} context
       * @param {Function} real_resolve_fn
       * @returns {Promise<void>}
       */
      set_package_registry(context, real_resolve_fn) {
        const ret = wasm.typstcompilerbuilder_set_package_registry(this.__wbg_ptr, addHeapObject(context), addHeapObject(real_resolve_fn));
        return takeObject(ret);
      }
      /**
       * @param {Uint8Array} data
       * @returns {Promise<void>}
       */
      add_raw_font(data) {
        const ret = wasm.typstcompilerbuilder_add_raw_font(this.__wbg_ptr, addHeapObject(data));
        return takeObject(ret);
      }
      /**
       * @param {any} font
       * @param {Function} blob
       * @returns {Promise<void>}
       */
      add_lazy_font(font, blob) {
        const ret = wasm.typstcompilerbuilder_add_lazy_font(this.__wbg_ptr, addHeapObject(font), addHeapObject(blob));
        return takeObject(ret);
      }
      /**
       * @returns {Promise<TypstCompiler>}
       */
      build() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.typstcompilerbuilder_build(ptr);
        return takeObject(ret);
      }
    };
    if (Symbol.dispose) TypstCompilerBuilder.prototype[Symbol.dispose] = TypstCompilerBuilder.prototype.free;
    TypstFontResolver = class _TypstFontResolver {
      static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(_TypstFontResolver.prototype);
        obj.__wbg_ptr = ptr;
        TypstFontResolverFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
      }
      __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TypstFontResolverFinalization.unregister(this);
        return ptr;
      }
      free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_typstfontresolver_free(ptr, 0);
      }
    };
    if (Symbol.dispose) TypstFontResolver.prototype[Symbol.dispose] = TypstFontResolver.prototype.free;
    TypstFontResolverBuilder = class {
      __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TypstFontResolverBuilderFinalization.unregister(this);
        return ptr;
      }
      free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_typstfontresolverbuilder_free(ptr, 0);
      }
      constructor() {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstfontresolverbuilder_new(retptr);
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          this.__wbg_ptr = r0 >>> 0;
          TypstFontResolverBuilderFinalization.register(this, this.__wbg_ptr, this);
          return this;
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @param {Uint8Array} buffer
       * @returns {any}
       */
      get_font_info(buffer) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstfontresolverbuilder_get_font_info(retptr, this.__wbg_ptr, addHeapObject(buffer));
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          if (r2) {
            throw takeObject(r1);
          }
          return takeObject(r0);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * Adds font data to the searcher.
       * @param {Uint8Array} buffer
       */
      add_raw_font(buffer) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstfontresolverbuilder_add_raw_font(retptr, this.__wbg_ptr, addHeapObject(buffer));
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          if (r1) {
            throw takeObject(r0);
          }
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * Adds callback that loads font data lazily to the searcher.
       * `get_font_info` can be used to get the font info.
       * @param {any} font
       * @param {Function} blob
       */
      add_lazy_font(font, blob) {
        try {
          const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          wasm.typstfontresolverbuilder_add_lazy_font(retptr, this.__wbg_ptr, addHeapObject(font), addHeapObject(blob));
          var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          if (r1) {
            throw takeObject(r0);
          }
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
        }
      }
      /**
       * @returns {Promise<TypstFontResolver>}
       */
      build() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.typstfontresolverbuilder_build(ptr);
        return takeObject(ret);
      }
    };
    if (Symbol.dispose) TypstFontResolverBuilder.prototype[Symbol.dispose] = TypstFontResolverBuilder.prototype.free;
    EXPECTED_RESPONSE_TYPES = /* @__PURE__ */ new Set(["basic", "cors", "default"]);
    typst_ts_web_compiler_default = __wbg_init;
    importWasmModule = async function(wasm_name, url) {
      throw new Error("Cannot import wasm module without importer: " + wasm_name + " " + url);
    };
  }
});

// ../../../recomposition-20261027/typesetter/.local/spike/node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/wasm-pack-shim.mjs
var wasm_pack_shim_exports = {};
__export(wasm_pack_shim_exports, {
  IncrServer: () => IncrServer,
  ProxyContext: () => ProxyContext,
  TypstCompileWorld: () => TypstCompileWorld,
  TypstCompiler: () => TypstCompiler,
  TypstCompilerBuilder: () => TypstCompilerBuilder,
  TypstFontResolver: () => TypstFontResolver,
  TypstFontResolverBuilder: () => TypstFontResolverBuilder,
  default: () => wasm_pack_shim_default,
  get_font_info: () => get_font_info,
  initSync: () => initSync,
  setImportWasmModule: () => setImportWasmModule
});
var wasm_pack_shim_default, nodeJsImportWasmModule, isNode;
var init_wasm_pack_shim = __esm({
  "../../../recomposition-20261027/typesetter/.local/spike/node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/wasm-pack-shim.mjs"() {
    init_typst_ts_web_compiler();
    init_typst_ts_web_compiler();
    init_typst_ts_web_compiler();
    wasm_pack_shim_default = typst_ts_web_compiler_default;
    nodeJsImportWasmModule = async function(wasm_name, url) {
      const escapeImport = new Function("m", "return import(m)");
      const { readFileSync } = await escapeImport("fs");
      const wasmPath = new URL(wasm_name, url);
      return await readFileSync(wasmPath).buffer;
    };
    isNode = typeof process !== "undefined" && process.versions != null && process.versions.node != null;
    if (isNode) {
      setImportWasmModule(nodeJsImportWasmModule);
    }
  }
});

// ../../../recomposition-20261027/typesetter/.local/spike/node_modules/@myriaddreamin/typst.ts/dist/esm/init.mjs
var ComponentBuilder = class {
  loadedFonts = /* @__PURE__ */ new Set();
  fetcher = fetch;
  setFetcher(fetcher) {
    this.fetcher = fetcher;
  }
  async loadFonts(builder, fonts) {
    const escapeImport = new Function("m", "return import(m)");
    const fetcher = this.fetcher ||= await (async function() {
      const { fetchBuilder, FileSystemCache } = await escapeImport("node-fetch-cache");
      const cache = new FileSystemCache({
        /// By default, we don't have a complicated cache policy.
        cacheDirectory: ".cache/typst/fonts"
      });
      const cachedFetcher = fetchBuilder.withCache(cache);
      return function(input, init) {
        const timeout = setTimeout(() => {
          console.warn("font fetching is stucking:", input);
        }, 15e3);
        return cachedFetcher(input, init).finally(() => {
          clearTimeout(timeout);
        });
      };
    })();
    const fontsToLoad = fonts.filter((font) => {
      if (font instanceof Uint8Array || typeof font === "object" && "info" in font) {
        return true;
      }
      if (this.loadedFonts.has(font)) {
        return false;
      }
      this.loadedFonts.add(font);
      return true;
    });
    const fontLists = await Promise.all(fontsToLoad.map(async (font) => {
      if (font instanceof Uint8Array) {
        await builder.add_raw_font(font);
        return;
      }
      if (typeof font === "object" && "info" in font) {
        await builder.add_lazy_font(font, "blob" in font ? font.blob : loadFontSync(font));
        return;
      }
      return new Uint8Array(await (await fetcher(font)).arrayBuffer());
    }));
    for (const font of fontLists) {
      if (!font) {
        continue;
      }
      await builder.add_raw_font(font);
    }
  }
  async build(options, builder, hooks) {
    const buildCtx = { ref: this, builder, hooks };
    for (const fn of options?.beforeBuild ?? []) {
      await fn(void 0, buildCtx);
    }
    if (hooks.latelyBuild) {
      hooks.latelyBuild(buildCtx);
    }
    return await builder.build();
  }
};
async function buildComponent(options, gModule, Builder, hooks) {
  await gModule.init(options?.getModule?.());
  return await new ComponentBuilder().build(options, new Builder(), hooks);
}
function loadFontSync(font) {
  return () => {
    const xhr = new XMLHttpRequest();
    xhr.overrideMimeType("text/plain; charset=x-user-defined");
    xhr.open("GET", font.url, false);
    xhr.send(null);
    if (xhr.status === 200 && (xhr.response instanceof String || typeof xhr.response === "string")) {
      return Uint8Array.from(xhr.response, (c) => c.charCodeAt(0));
    }
    return new Uint8Array();
  };
}

// ../../../recomposition-20261027/typesetter/.local/spike/node_modules/@myriaddreamin/typst.ts/dist/esm/internal.types.mjs
var kObject = /* @__PURE__ */ Symbol.for("reflexo-obj");
var TypstDefaultParams;
(function(TypstDefaultParams2) {
  TypstDefaultParams2[TypstDefaultParams2["PIXEL_PER_PT"] = 3] = "PIXEL_PER_PT";
})(TypstDefaultParams || (TypstDefaultParams = {}));

// ../../../recomposition-20261027/typesetter/.local/spike/node_modules/@myriaddreamin/typst.ts/dist/esm/options.init.mjs
var _textFonts = [
  "DejaVuSansMono-Bold.ttf",
  "DejaVuSansMono-BoldOblique.ttf",
  "DejaVuSansMono-Oblique.ttf",
  "DejaVuSansMono.ttf",
  "LibertinusSerif-Bold.otf",
  "LibertinusSerif-BoldItalic.otf",
  "LibertinusSerif-Italic.otf",
  "LibertinusSerif-Regular.otf",
  "LibertinusSerif-Semibold.otf",
  "LibertinusSerif-SemiboldItalic.otf",
  "NewCM10-Bold.otf",
  "NewCM10-BoldItalic.otf",
  "NewCM10-Italic.otf",
  "NewCM10-Regular.otf",
  "NewCMMath-Bold.otf",
  "NewCMMath-Book.otf",
  "NewCMMath-Regular.otf"
];
var _cjkFonts = [
  "InriaSerif-Bold.ttf",
  "InriaSerif-BoldItalic.ttf",
  "InriaSerif-Italic.ttf",
  "InriaSerif-Regular.ttf",
  "Roboto-Regular.ttf",
  "NotoSerifCJKsc-Regular.otf"
];
var _emojiFonts = ["TwitterColorEmoji.ttf", "NotoColorEmoji-Regular-COLR.subset.ttf"];
function _resolveAssets(options) {
  const fonts = [];
  if (options && options?.assets !== false && options?.assets?.length && options?.assets?.length > 0) {
    let defaultPrefix = {
      text: "https://cdn.jsdelivr.net/gh/typst/typst-assets@v0.13.1/files/fonts/",
      _: "https://cdn.jsdelivr.net/gh/typst/typst-dev-assets@v0.13.1/files/fonts/"
    };
    let assetUrlPrefix = options.assetUrlPrefix ?? defaultPrefix;
    if (typeof assetUrlPrefix === "string") {
      assetUrlPrefix = { _: assetUrlPrefix };
    } else {
      assetUrlPrefix = { ...defaultPrefix, ...assetUrlPrefix };
    }
    for (const key of Object.keys(assetUrlPrefix)) {
      const u = assetUrlPrefix[key];
      if (u[u.length - 1] !== "/") {
        assetUrlPrefix[key] = u + "/";
      }
    }
    const prefix = (asset, f) => f.map((font) => (assetUrlPrefix[asset] || assetUrlPrefix["_"]) + font);
    for (const asset of options.assets) {
      switch (asset) {
        case "text":
          fonts.push(...prefix(asset, _textFonts));
          break;
        case "cjk":
          fonts.push(...prefix(asset, _cjkFonts));
          break;
        case "emoji":
          fonts.push(...prefix(asset, _emojiFonts));
          break;
      }
    }
  }
  return fonts;
}
function loadFonts(userFonts, options) {
  const assetFonts = _resolveAssets(options);
  const loader = async (_, { ref, builder }) => {
    if (options?.fetcher) {
      ref.setFetcher(options.fetcher);
    }
    await ref.loadFonts(builder, [...userFonts, ...assetFonts]);
  };
  loader._preloadRemoteFontOptions = options;
  loader._kind = "fontLoader";
  return loader;
}

// ../../../recomposition-20261027/typesetter/.local/spike/node_modules/@myriaddreamin/typst.ts/dist/esm/wasm.mjs
var once = (fn) => {
  let called = false;
  let res;
  return () => {
    if (called) {
      return res;
    }
    called = true;
    return res = fn();
  };
};
var LazyWasmModule = class {
  wasmBin;
  initOnce;
  constructor(initFn) {
    if (typeof initFn !== "function") {
      throw new Error("initFn is not a function");
    }
    this.initOnce = once(async () => {
      await initFn(this.wasmBin);
    });
  }
  async init(module) {
    this.wasmBin = module;
    await this.initOnce();
  }
};

// ../../../recomposition-20261027/typesetter/.local/spike/node_modules/@myriaddreamin/typst.ts/dist/esm/compiler.mjs
var CompileFormatEnum;
(function(CompileFormatEnum2) {
  CompileFormatEnum2[CompileFormatEnum2["vector"] = 0] = "vector";
  CompileFormatEnum2[CompileFormatEnum2["pdf"] = 1] = "pdf";
  CompileFormatEnum2[CompileFormatEnum2["_dummy"] = 2] = "_dummy";
})(CompileFormatEnum || (CompileFormatEnum = {}));
var IncrementalServer = class {
  /**
   * @internal
   */
  [kObject];
  /**
   * @internal
   */
  constructor(s) {
    this[kObject] = s;
  }
  /**
   * Reset the incremental server to the initial state.
   */
  reset() {
    this[kObject].reset();
  }
  /**
   * Return current result.
   */
  current() {
    return this[kObject].current();
  }
  /**
   * Also attach the debug info to the result.
   */
  setAttachDebugInfo(enable) {
    this[kObject].set_attach_debug_info(enable);
  }
};
var TypstFontResolverCons;
/* @__PURE__ */ (function(TypstFontResolverCons2) {
})(TypstFontResolverCons || (TypstFontResolverCons = {}));
function createTypstFontBuilder() {
  return new TypstFontBuilderDriver();
}
var TypstWorld = class {
  [kObject];
  constructor(world) {
    this[kObject] = world;
  }
  /**
   * Compile the paged document.
   *
   * @param {DiagnosticsFormat} format - The format of the diagnostics.
   * @returns {Promise<{ diagnostics?: DiagnosticsData[DiagnosticsFormat][] }>} - The result of the compilation.
   */
  compile(opts) {
    return this[kObject].compile(0, getDiagnosticsArg(opts?.diagnostics));
  }
  /**
   * Compile the paged document.
   *
   * @param {DiagnosticsFormat} format - The format of the diagnostics.
   * @returns {Promise<{ diagnostics?: DiagnosticsData[DiagnosticsFormat][] }>} - The result of the compilation.
   */
  compileHtml(opts) {
    return this[kObject].compile(1, getDiagnosticsArg(opts?.diagnostics));
  }
  /**
   * Runs query on the paged document.
   */
  async query(options) {
    return JSON.parse(this[kObject].query(0, options.selector, options.field));
  }
  /**
   * Get the title of the paged document.
   * Throw error if the world didn't compile the paged document.
   *
   * @returns {string | undefined} - The title of the paged document.
   */
  title() {
    return this[kObject].title(0);
  }
  /**
   * Export the paged document as vector format.
   *
   * @returns {Uint8Array | undefined} - The title of the paged document.
   */
  vector(opts) {
    return this[kObject].get_artifact(0, getDiagnosticsArg(opts?.diagnostics)) || {};
  }
  /**
   * Export the paged document to PDF.
   *
   * @returns {Uint8Array | undefined} - The title of the paged document.
   */
  pdf(opts) {
    return this[kObject].get_artifact(1, getDiagnosticsArg(opts?.diagnostics)) || {};
  }
};
var gCompilerModule = (module) => new LazyWasmModule(async (bin) => {
  return await module.default(bin);
});
function createTypstCompiler() {
  return new TypstCompilerDriver();
}
var TypstFontBuilderDriver = class {
  fontBuilderJs;
  fontBuilder;
  async init(options) {
    this.fontBuilderJs = await (options?.getWrapper?.() || Promise.resolve().then(() => (init_wasm_pack_shim(), wasm_pack_shim_exports)));
    await gCompilerModule(this.fontBuilderJs).init(options?.getModule?.());
    this.fontBuilder = new this.fontBuilderJs.TypstFontResolverBuilder();
  }
  async getFontInfo(font_buffer) {
    return this.fontBuilder.get_font_info(font_buffer);
  }
  async addFontData(font_buffer) {
    this.fontBuilder.add_raw_font(font_buffer);
  }
  async addLazyFont(info, blob) {
    return this.fontBuilder.add_lazy_font(info, blob);
  }
  async build(cb) {
    const fonts = await this.fontBuilder.build();
    const result = await cb(fonts);
    fonts.free();
    return result;
  }
};
var TypstCompilerDriver = class _TypstCompilerDriver {
  compiler;
  compilerJs;
  static defaultAssets = ["text"];
  constructor() {
  }
  async init(options) {
    this.compilerJs = await (options?.getWrapper?.() || Promise.resolve().then(() => (init_wasm_pack_shim(), wasm_pack_shim_exports)));
    const TypstCompilerBuilder2 = this.compilerJs.TypstCompilerBuilder;
    const compilerOptions = { ...options || {} };
    const beforeBuild = compilerOptions.beforeBuild ??= [];
    const hasPreloadRemoteFonts = beforeBuild.some((fn) => fn._preloadRemoteFontOptions !== void 0);
    const hasSpecifiedAssets = beforeBuild.some((fn) => fn._preloadRemoteFontOptions?.assets !== void 0);
    const hasDisableAssets = beforeBuild.some((fn) => fn._preloadRemoteFontOptions?.assets === false);
    if (!hasPreloadRemoteFonts || !hasSpecifiedAssets && !hasDisableAssets) {
      beforeBuild.push(loadFonts([], { assets: _TypstCompilerDriver.defaultAssets }));
    }
    const hasFontLoader = beforeBuild.some((fn) => fn._kind === "fontLoader");
    if (!hasFontLoader) {
      throw new Error("TypstCompiler: no font loader found, please use font loaders, e.g. loadFonts or preloadSystemFonts");
    }
    this.compiler = await buildComponent(options, gCompilerModule(this.compilerJs), TypstCompilerBuilder2, {});
  }
  setFonts(fonts) {
    this.compiler.set_fonts(fonts);
  }
  compile(options) {
    return new Promise((resolve) => {
      const world = this.compiler.snapshot(options.root, options.mainFilePath, convertInputs(options.inputs));
      if ("incrementalServer" in options) {
        resolve(world.incr_compile(options.incrementalServer[kObject], getDiagnosticsArg(options.diagnostics)));
        return;
      }
      resolve(world.get_artifact(options.format || CompileFormatEnum.vector, getDiagnosticsArg(options.diagnostics)));
    });
  }
  async runWithWorld(options, cb) {
    const world = this.compiler.snapshot(options.root, options.mainFilePath, convertInputs(options.inputs));
    let result = await cb(new TypstWorld(world));
    world.free();
    return result;
  }
  query(options) {
    return this.runWithWorld(options, async (world) => {
      return JSON.parse(await world.query(options));
    });
  }
  getSemanticTokenLegend() {
    return new Promise((resolve) => {
      resolve(this.compiler.get_semantic_token_legend());
    });
  }
  getSemanticTokens(opts) {
    return new Promise((resolve) => {
      this.compiler.reset();
      resolve(this.compiler.get_semantic_tokens(opts.offsetEncoding || "utf-16", opts.mainFilePath, opts.resultId));
    });
  }
  async withIncrementalServer(f) {
    const srv = new IncrementalServer(this.compiler.create_incr_server());
    try {
      return await f(srv);
    } finally {
      srv[kObject].free();
    }
  }
  async getAst(mainFilePath) {
    return this.compiler.get_ast(mainFilePath);
  }
  async reset() {
    await new Promise((resolve) => {
      this.compiler.reset();
      resolve(void 0);
    });
  }
  addSource(path, source) {
    if (arguments.length > 2) {
      throw new Error("use of addSource(path, source, isMain) is deprecated, please use addSource(path, source) instead");
    }
    this.compiler.add_source(path, source);
  }
  mapShadow(path, content) {
    this.compiler.map_shadow(path, content);
  }
  unmapShadow(path) {
    this.compiler.unmap_shadow(path);
  }
  resetShadow() {
    this.compiler.reset_shadow();
  }
  renderPageToCanvas() {
    throw new Error("Please use the api TypstRenderer.renderToCanvas in v0.4.0");
  }
};
createTypstCompiler._impl = TypstCompilerDriver;
function convertInputs(inputs) {
  return inputs ? Object.entries(inputs) : void 0;
}
function getDiagnosticsArg(diagnostics) {
  switch (diagnostics) {
    case "none":
      return 1;
    case "unix":
      return 2;
    case "full":
    default:
      return 3;
  }
}
export {
  createTypstCompiler,
  createTypstFontBuilder,
  loadFonts
};
