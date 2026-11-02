/*
xdvipdfmx:warning: Color stack underflow. Just ignore.
xdvipdfmx:warning: Color stack underflow. Just ignore.
xdvipdfmx:warning: Color stack underflow. Just ignore.
xdvipdfmx:warning: Color stack underflow. Just ignore.
xdvipdfmx:warning: Color stack underflow. Just ignore.

kpathsea: Running mktexpk --mfmode / --bdpi 600 --mag 1+264/600 --dpi 864 ec-qhvr
kpathsea: fork(): Function not implemented
kpathsea: Appending font creation commands to missfont.log.
xdvipdfmx:warning: Could not locate a virtual/physical font for TFM "ec-qhvr".
xdvipdfmx:warning: >> There are no valid font mapping entry for this font.
xdvipdfmx:warning: >> Font file name "ec-qhvr" was assumed but failed to locate that font.
xdvipdfmx:fatal: Cannot proceed without .vf or "physical" font for PDF output...

No output PDF file written.
*/

class BusytexDataPackageResolver {
    constructor(data_packages_js, texmf_system = [], texmf_local = [], remap = {
        config: null,
        firstaid: 'latex-firstaid',
        hyphen: null,
        jknapltx: null,
        latexconfig: null,
        pdfwin: null,
        plweb: 'pl',
        symbol: null,
        syntax: null,
        third: null,
        twoup: null,
        zapfding: null
    }) {
        this.regex_usepackage = /\\usepackage(\[.*?\])?\{(.+?)\}/g; // [2019/06/21 v0.4.0 A clean LaTeX style for thesis documents] : {source: 'local', used: false}
        this.regex_providespackage = /\\ProvidesPackage\{(.+?)\}(\[.*?\])?/g;
        this.basename = path => path.slice(path.lastIndexOf('/') + 1);
        this.dirname = path => path.slice(0, path.lastIndexOf('/'));
        this.isfile = path => this.basename(path).includes('.');

        this.msgs = [];
        this.data_packages_js = data_packages_js;
        this.data_packages = data_packages_js.map(data_package_js => [data_package_js, fetch(data_package_js).then(r => r.text()).then(data_package_js_script => new Set(Array.from(data_package_js_script.matchAll(this.regex_providespackage)).map(groups => groups[1].toLowerCase().trim())))]);
        console.log('BusytexDataPackageResolver', this.data_packages);
        this.remap = remap;
        this.texmf_local_texmfdist_tex = texmf_local.map(t => t + '/texmf-dist/tex/');
        this.texmf_system_texmfdist_tex = texmf_system.map(t => t + '/texmf-dist/tex/');
        this.texmf_texmfdist_tex = [...this.texmf_system_texmfdist_tex, ...this.texmf_local_texmfdist_tex];
        this.data_packages_cache = null;
    }

    async resolve_data_packages() {
        const values = await Promise.all(this.data_packages.map(([k, v]) => v));
        return this.data_packages.map(([k, v], i) => [k, Array.from(values[i]).sort()]);
    }

    cache_data_packages() {
        if (!this.data_packages_cache)
            this.data_packages_cache = Promise.all(this.data_packages_js.map(data_package_js => fetch(data_package_js.replace('.js', '.data'), { mode: 'no-cors' })));
    }

    extract_tex_package_name(path, contents = '') {
        // implicitly excludes /.../temxf-dist/{fonts,bibtex}
        // cat urls.txt | while read URL; do echo $(curl -sI ${URL%$'\r'} | head -n 1 | cut -d' ' -f2) $URL; done | grep 404 | sort | uniq

        // https://ctan.org/tex-archive/macros/latex/required/graphics, graphicx

        const splitrootdir = path => { const splitted = path.split('/'); return [splitted[0], splitted.slice(1).join('/')]; };

        if (!path.endsWith('.sty'))
            return null;

        const basename = this.basename(path);
        let tex_package_name = basename.slice(0, basename.length - '.sty'.length);
        if (this.isfile(path)) {
            const prefix = this.texmf_texmfdist_tex.find(t => path.startsWith(t));
            if (contents) {
                const tex_packages = contents.split('\n').filter(l => l.trim().startsWith('\\ProvidesPackage')).map(l => Array.from(l.matchAll(this.regex_providespackage)).filter(groups => groups.length >= 2).map(groups => groups[0])).flat();
                if (tex_packages.length > 0)
                    tex_package_name = tex_packages[0];
            }
            else if (prefix) {
                tex_package_name = splitrootdir(splitrootdir(path.slice(prefix.length))[1])[0];
                this.msgs.push([tex_package_name, path, 'https://ctan.org/pkg/' + tex_package_name]);

                if (tex_package_name in this.remap)
                    tex_package_name = this.remap[tex_package_name];
            }
        }

        return tex_package_name;
    }

    async resolve(files, main_tex_path, data_packages_js = null) {
        const tex_packages = files.filter(f => typeof (f.contents) == 'string' && f.path == main_tex_path).map(f => f.contents.split('\n').filter(l => l.trim().startsWith('\\usepackage')).map(l => Array.from(l.matchAll(this.regex_usepackage)).filter(groups => groups.length >= 2).map(groups => groups.pop().split(',')))).flat().flat().flat();

        const tex_packages_local = new Set(files.filter(f => this.texmf_local_texmfdist_tex.some(t => f.path.startsWith(t)) || f.path.endsWith('.sty')).map(f => this.extract_tex_package_name(f.path, typeof (f.contents) == 'string' ? f.contents : '')).filter(f => f));

        const tex_packages_to_resolve = tex_packages.filter(tex_package => !tex_packages_local.has(tex_package));

        const resolved = Object.fromEntries(tex_packages.map(tex_package => ([tex_package, { used: true, source: null }])));
        for (const tex_package of tex_packages_local) {
            resolved[tex_package] = resolved[tex_package] || {};
            resolved[tex_package].source = 'local';
            resolved[tex_package].used = resolved[tex_package].used || false;
        }

        let update_data_packages_js = false;
        const tex_packages_not_resolved = [];
        let data_packages = [];

        if (data_packages_js === null) {
            update_data_packages_js = true;
            data_packages = this.data_packages;
            data_packages_js = new Set();
        }
        else {
            update_data_packages_js = false;
            data_packages = this.data_packages.filter(([data_package_js, tex_packages]) => data_packages_js.includes(data_package_js));
        }

        for (const tex_package of tex_packages_to_resolve) {
            for (const [data_package_js, tex_packages] of [...data_packages, [null, null]]) {
                if (tex_packages !== null && (await tex_packages).has(tex_package)) {
                    resolved[tex_package].source = data_package_js;

                    if (update_data_packages_js)
                        data_packages_js.add(data_package_js);
                    break;
                }
            }
        }

        return resolved;
    }
}


class BusytexBibtexResolver {
    // Callers may pass file contents as text or as bytes read from storage.
    static text(contents) {
        if (typeof contents == 'string')
            return contents;
        if (ArrayBuffer.isView(contents) || contents instanceof ArrayBuffer)
            return new TextDecoder().decode(contents);
        return '';
    }

    matches(files, needles) {
        return files.some(f => {
            if (!f.path.endsWith('.tex'))
                return false;

            const text = BusytexBibtexResolver.text(f.contents);
            return needles.some(needle => text.includes(needle));
        });
    }

    resolve(files, bib_tex_commands = ['\\bibliography', '\\printbibliography']) {
        return this.matches(files, bib_tex_commands);
    }

    resolve_backend(files, biblatex_backend_options = ['backend=biber', 'backend = biber']) {
        return this.matches(files, biblatex_backend_options) ? 'biber' : 'bibtex8';
    }
}

class BusytexPipeline {
    static texmf_system = ['/texlive', '/texmf'];
    static VerboseSilent = 'silent';
    static VerboseInfo = 'info';
    static VerboseDebug = 'debug';

    //FIXME begin: have to do static to execute LZ4 data packages: https://github.com/emscripten-core/emscripten/issues/12347
    static preRun = [];
    static calledRun = false;
    static data_packages = [];
    static locateFile(remote_package_name) {
        return BusytexPipeline.data_packages.map(data_package_js => data_package_js.replace('.js', '.data')).find(data_file => data_file.endsWith(remote_package_name));
    }
    //FIXME end

    static ScriptLoaderDocument(src) {
        return new Promise((resolve, reject) => {
            let s = self.document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = reject;
            self.document.head.appendChild(s);
        });
    }

    static ScriptLoaderRequire(src) {
        return new Promise(resolve => self.require([src], resolve));
    }

    static ScriptLoaderWorker(src) {
        return Promise.resolve(self.importScripts(src));
    }

    load_package(data_package_js) {
        if (data_package_js in this.data_package_promises)
            return this.data_package_promises[data_package_js];
        BusytexPipeline.calledRun = false;
        BusytexPipeline.data_packages.push(data_package_js);
        if (!BusytexPipeline.FS_createPath) {
            const noop = () => { };
            BusytexPipeline.FS_createPath = noop;
            BusytexPipeline.FS_createDataFile = noop;
            BusytexPipeline.FS_createPreloadedFile = noop;
            BusytexPipeline.FS_createLazyFile = noop;
            BusytexPipeline.FS_unlink = noop;
        }
        const promise = this.script_loader(data_package_js);
        this.data_package_promises[data_package_js] = promise;
        return promise;
    }

    constructor(busytex_js, busytex_wasm, data_packages_js, preload_data_packages_js, texmf_local, print, on_initialized, preload, script_loader, biber_js = null, biber_wasm = null, biber_data = null) {
        this.print = text => { print(text); };
        this.preload = preload;
        this.script_loader = script_loader;

        this.project_dir = '/home/web_user/project_dir';
        this.bin_busytex = '/bin/busytex';
        this.fmt = {
            pdftex: '/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt',
            xetex: '/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt',
            luahbtex: '/texlive/texmf-dist/texmf-var/web2c/luahbtex/luahblatex.fmt',
            luatex: '/texlive/texmf-dist/texmf-var/web2c/luahbtex/lualatex.fmt',
        };
        this.dir_texmfdist = [...BusytexPipeline.texmf_system, ...texmf_local].map(texmf => texmf + '/texmf-dist').join(':');
        this.dir_texmfvar = '/texlive/texmf-dist/texmf-var';
        this.dir_cnf = '/texlive/texmf-dist/web2c';
        this.dir_fontconfig = '/texlive';//'/etc/fonts';
        this.texmflog = '/tmp/texmf.log';
        this.missfontlog = 'missfont.log'; // http://tug.ctan.org/info/tex-font-errors-cheatsheet/tex-font-cheatsheet.pdf

        this.verbose_args =
        {
            [BusytexPipeline.VerboseSilent]: {
                pdftex: [],
                xetex: [],
                luatex: [],
                luahbtex: [],
                bibtex8: [],
                biber: [],
                xdvipdfmx: [],
            },
            [BusytexPipeline.VerboseInfo]: {
                pdftex: ['-kpathsea-debug', '32'],
                xetex: ['-kpathsea-debug', '32'],
                luatex: ['-kpathsea-debug', '32'],
                luahbtex: ['-kpathsea-debug', '32'],
                xdvipdfmx: ['--kpathsea-debug', '32', '-v'],
                bibtex8: ['--debug', 'search'],
                biber: [],
            },
            [BusytexPipeline.VerboseDebug]: {
                pdftex: ['-kpathsea-debug', '63', '-recorder'],
                xetex: ['-kpathsea-debug', '63', '-recorder'],
                luatex: ['-kpathsea-debug', '63', '-recorder', '--debug-format'],
                luahbtex: ['-kpathsea-debug', '63', '-recorder', '--debug-format'],
                xdvipdfmx: ['--kpathsea-debug', '63', '-vv'],
                bibtex8: ['--debug', 'all'],
                biber: ['--debug'],
            },
        };
        this.supported_drivers = ['xetex_bibtex8_dvipdfmx', 'pdftex_bibtex8', 'luahbtex_bibtex8', 'luatex_bibtex8'];
        this.biber = biber_js && biber_wasm && biber_data && typeof BusytexBiber != 'undefined' ? new BusytexBiber(biber_js, biber_wasm, biber_data, this.print, this.script_loader) : null;

        this.error_messages_fatal = ['Fatal error occurred', 'That was a fatal error', ':fatal:', '! Undefined control sequence.', 'undefined old font command'];
        this.error_messages_all = this.error_messages_fatal.concat(['no output PDF file produced', 'No pages of output.']);

        this.rerun_patterns = [
            'Rerun to get',
            'Rerun LaTeX',
            'rerunfilecheck',
            'Label(s) may have changed',
            'There were undefined references',
            'run LaTeX again',
        ];

        this.max_tex_passes = 3;

        this.env = {
            TEXMFDIST: this.dir_texmfdist,
            TEXMFVAR: this.dir_texmfvar,
            TEXMFCACHE: this.dir_texmfvar,
            TEXMFCNF: this.dir_cnf,
            TEXMFLOG: this.texmflog,
            FONTCONFIG_PATH: this.dir_fontconfig,
            FONTCONFIG_FILE: this.dir_fontconfig + '/fonts.conf',
            ICU_DATA: '/texlive/',
            TEXLIVE_REMOTE_ENDPOINT: ''
        };

        this.remove = (FS, log_path) => FS.analyzePath(log_path).exists ? FS.unlink(log_path) : null;
        this.read_all_text = (FS, log_path) => FS.analyzePath(log_path).exists ? FS.readFile(log_path, { encoding: 'utf8' }).trim() : '';
        this.read_all_bytes = (FS, pdf_path) => FS.analyzePath(pdf_path).exists ? FS.readFile(pdf_path, { encoding: 'binary' }) : new Uint8Array();
        this.mkdir_p = (FS, PATH, dirpath, dirs = new Set()) => {
            if (!dirpath || dirpath === '/' || dirs.has(dirpath))
                return;
            this.mkdir_p(FS, PATH, PATH.dirname(dirpath), dirs);
            if (!FS.analyzePath(dirpath).exists)
                FS.mkdir(dirpath);
            dirs.add(dirpath);
        };

        this.bibtex_resolver = new BusytexBibtexResolver();
        this.data_package_resolver = new BusytexDataPackageResolver(data_packages_js, BusytexPipeline.texmf_system, texmf_local);
        this.wasm_module_promise = fetch(busytex_wasm).then(response => {
            if (!response.ok) throw new Error(`Failed to fetch WASM module: ${busytex_wasm} (HTTP ${response.status})`);
            return WebAssembly.compileStreaming ? WebAssembly.compileStreaming(response) : response.arrayBuffer().then(WebAssembly.compile);
        });
        this.mem_header_size = 2 ** 26;

        this.em_module_promise = this.script_loader(busytex_js);
        BusytexPipeline.data_packages = [];
        this.data_package_promises = {};
        this.preload_data_packages_js = preload_data_packages_js;
        for (const data_package_js of this.preload_data_packages_js)
            this.load_package(data_package_js);
        this.Module = this.reload_module_if_needed(this.preload !== false, this.env, this.project_dir, this.preload_data_packages_js);

        this.on_initialized = null;
        this.on_initialized_promise = new Promise(resolve => (this.on_initialized = resolve));
        this.on_initialized_promise_notification = this.on_initialized_promise.then(on_initialized);

        this.on_initialization_error = null;
    }

    terminate() {
        this.Module = null;
    }

    async reload_module_if_needed(cond, env, project_dir, data_packages_js) {
        if (cond) {
            return this.reload_module(env, project_dir, data_packages_js, true);
        }
        else if (this.Module) {
            const Module = await this.Module;
            const enabled_packages_js = Module.data_packages_js;
            const new_data_packages_js = data_packages_js.filter(data_package_js => !enabled_packages_js.includes(data_package_js));

            if (new_data_packages_js.length > 0) {
                return this.reload_module(env, project_dir, Array.from(enabled_packages_js).concat(Array.from(new_data_packages_js)), false);
            }

            return Module;
        }
    }

    async reload_module(env, project_dir, data_packages_js = [], report_applet_versions = false) {
        const data_packages_js_promise = data_packages_js.map(data_package_js => this.load_package(data_package_js));
        const [em_module, wasm_module] = await Promise.all([this.em_module_promise, WebAssembly.compileStreaming ? this.wasm_module_promise : this.wasm_module_promise.then(r => r.arrayBuffer()), ...data_packages_js_promise]);
        const { print, init_env } = this;

        const pre_run_packages = Module => () => {
            Module['FS_createPath'] = Module.FS.createPath;
            Module['FS_createDataFile'] = Module.FS.createDataFile;
            Module['FS_createPreloadedFile'] = Module.FS.createPreloadedFile;
            Module['FS_createLazyFile'] = Module.FS.createLazyFile;
            Module['FS_unlink'] = Module.FS.unlink;

            Object.setPrototypeOf(BusytexPipeline, Module);

            for (const preRun of BusytexPipeline.preRun) {
                if (Module.preRuns.includes(preRun))
                    continue;

                preRun(Module);
                Module.preRuns.push(preRun);
            }
        }

        const Module =
        {
            thisProgram: this.bin_busytex,
            noInitialRun: true,
            totalDependencies: 0,
            prefix: '',
            preRuns: [],
            data_packages_js: data_packages_js,
            pre_run_packages: pre_run_packages,

            preRun: [() => { Object.assign(Module.ENV, env); Module.FS.mkdir(project_dir); self.LZ4 = Module.LZ4; }, () => pre_run_packages(Module)()],

            instantiateWasm(imports, successCallback) {
                WebAssembly.instantiate(wasm_module, imports).then(output => successCallback(WebAssembly.compileStreaming ? output : output.instance)).catch(err => { throw new Error('Error while initializing BusyTex!\n\n' + err.toString()) });
                return {};
            },

            do_print: true,
            output_stdout: '',
            print(text) {
                text = (arguments.length > 1 ? Array.prototype.slice.call(arguments).join(' ') : text) || '';
                Module.output_stdout += text + '\n';
                if (Module.do_print)
                    Module.setStatus(Module.thisProgram + ' stdout: ' + text);
            },
            output_stderr: '',
            printErr(text) {
                text = (arguments.length > 1 ? Array.prototype.slice.call(arguments).join(' ') : text) || '';
                Module.output_stderr += text + '\n';
                Module.setStatus(Module.thisProgram + ' stderr: ' + text);
            },

            setPrefix(text) {
                this.prefix = text;
            },

            setStatus(text) {
                if (this.do_print)
                    print(text);
            },

            monitorRunDependencies(left) {
                this.totalDependencies = Math.max(this.totalDependencies, left);
                Module.setStatus(left ? 'Preparing... (' + (this.totalDependencies - left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
            },

            callMainWithRedirects(args = [], print = false) {
                const Module = this;
                Module.do_print = print;
                Module.output_stdout = '';
                Module.output_stderr = '';
                Module.setPrefix(args[0]);
                
                // The applets exit without closing their files, and restoring the memory header between runs
                // discards libc's FILE table but not FS.streams, so every run leaks its open files. With
                // preload the module is reused across compiles, and once 4096 streams are open (Emscripten's
                // limit) later runs fail to open fonts. Close whatever this run left open.
                const open_before = new Set(Module.FS.streams.filter(stream => stream).map(stream => stream.fd));
                let exit_code;
                try {
                    exit_code = Module.callMain(args);
                    Module._flush_streams();
                }
                finally {
                    for (const stream of Module.FS.streams)
                        if (stream && !open_before.has(stream.fd))
                            Module.FS.close(stream);
                }

                return { exit_code: exit_code, stdout: Module.output_stdout, stderr: Module.output_stderr };
            }
        };

        const moduleFactory = typeof busytex !== 'undefined' ? busytex
            : typeof pdftex !== 'undefined' ? pdftex
                : typeof xetex !== 'undefined' ? xetex
                    : typeof luahbtex !== 'undefined' ? luahbtex
                        : null;
        if (!moduleFactory) throw new Error('No BusyTeX module factory found. Ensure busytex.js or a per-engine .js file is loaded.');
        const initialized_module = await moduleFactory(Module);

        if (!(this.mem_header_size % 4 == 0 && initialized_module.HEAP32.slice(this.mem_header_size / 4).every(x => x == 0)))
            throw new Error(`Memory header size [${this.mem_header_size}] must be divisible by 4, and remaining memory must be zero`);

        if (report_applet_versions) {
            const applets = initialized_module.callMainWithRedirects().stdout.split('\n').filter(line => line.length > 0);
            initialized_module.applet_versions = Object.fromEntries(applets.map(applet => ([applet, applet != 'makeindex' ? initialized_module.callMainWithRedirects([applet, '--version']).stdout : 'makeindex does not support --version'])));
            // TODO: exception here not caught?
            this.on_initialized(initialized_module.applet_versions);
        }
        else
            initialized_module.applet_versions = {};

        return initialized_module;
    }

    _needs_rerun(log_text) {
        return this.rerun_patterns.some(p => log_text.includes(p));
    }

    async _run_biber(FS, tex_path, files, verbose_args, logs) {
        const bcf_path = tex_path.replace('.tex', '.bcf');
        const bbl_path = tex_path.replace('.tex', '.bbl');

        if (!FS.analyzePath(bcf_path).exists) {
            this.print('$ # no .bcf produced, biber has nothing to do');
            return 0;
        }

        const inputs = [{ path: bcf_path, contents: FS.readFile(bcf_path, { encoding: 'utf8' }) }];
        for (const f of files) {
            if (f.path.endsWith('.bib') && f.contents != null)
                inputs.push({ path: f.path, contents: f.contents });
        }

        const bbl = await this.biber.run(bcf_path, inputs, verbose_args);
        const exit_code = bbl == null ? 1 : 0;

        if (bbl != null)
            FS.writeFile(bbl_path, bbl);

        logs.push({ cmd: `biber ${bcf_path}`, texmflog: '', missfontlog: '', log: this.biber.last_output, aux: bbl || '', stdout: this.biber.last_output, stderr: '', exit_code });
        return exit_code;
    }

    _run_cmd(Module, FS, cmd, error_messages, verbose, log_path, blg_path, aux_path, bbl_path, mem_header, logs) {
        const is_bibtex = cmd[0].startsWith('bibtex');
        const cmd_log_path = is_bibtex ? blg_path : log_path;
        const cmd_aux_path = is_bibtex ? bbl_path : aux_path;

        this.remove(FS, this.texmflog);
        this.remove(FS, this.missfontlog);
        this.remove(FS, cmd_log_path);

        this.print('$ busytex ' + cmd.join(' '));
        const { exit_code, stdout, stderr } = Module.callMainWithRedirects([...cmd], verbose != BusytexPipeline.VerboseSilent);

        Module.HEAPU8.fill(0);
        Module.HEAPU8.set(mem_header);

        this.print('$ echo $?');
        this.print(`${exit_code}\n`);

        const aux = this.read_all_text(FS, cmd_aux_path);
        const log = this.read_all_text(FS, cmd_log_path);
        const effective_exit_code = stdout.trim() ? (error_messages.some(err => stdout.includes(err)) ? exit_code : 0) : exit_code;

        logs.push({
            cmd: cmd.join(' '),
            texmflog: (verbose == BusytexPipeline.VerboseInfo || verbose == BusytexPipeline.VerboseDebug) ? this.read_all_text(FS, this.texmflog) : '',
            missfontlog: (verbose == BusytexPipeline.VerboseInfo || verbose == BusytexPipeline.VerboseDebug) ? this.read_all_text(FS, this.missfontlog) : '',
            log: log.trim(),
            aux: aux.trim(),
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exit_code: effective_exit_code
        });

        return { exit_code: effective_exit_code, log };
    }

    async read_project_files(dir = null) {
        const Module = await this.Module;
        if (!Module) return [];
        const { FS, PATH } = Module;
        const root = dir || this.project_dir;
        const results = [];
        const walk = dir => {
            for (const name of FS.readdir(dir)) {
                if (name === '.' || name === '..') continue;
                const full = PATH.join(dir, name);
                const stat = FS.stat(full);
                if (FS.isDir(stat.mode)) {
                    walk(full);
                } else {
                    results.push({ path: full.slice(root.length + 1), contents: this.read_all_bytes(FS, full) });
                }
            }
        };
        if (FS.analyzePath(root).exists)
            walk(root);
        return results;
    }

    async write_texlive_remote_files(files) {
        const Module = await this.Module;
        if (!Module) throw new Error('Module not initialized');
        for (const { name, format, contents } of files)
            Module.kpse_remote_register(name, format != null ? format : 26, contents);
    }

    async write_texlive_remote_misses(keys) {
        const Module = await this.Module;
        if (!Module) throw new Error('Module not initialized');
        Module.kpse_remote_register_misses(keys);
    }

    async compile(files, main_tex_path, bibtex, biber = null, makeindex = null, rerun = null, verbose, driver, data_packages_js = [], remote_endpoint = '', shell_escape = false) {
        if (!this.supported_drivers.includes(driver))
            throw new Error(`Driver [${driver}] is not supported, only [${this.supported_drivers}] are supported`);
        this.print(`New compilation started: [${main_tex_path}]`);

        if (bibtex === null)
            bibtex = this.bibtex_resolver.resolve(files);

        const bib_backend = biber === null ? this.bibtex_resolver.resolve_backend(files) : (biber ? 'biber' : 'bibtex8');
        if (biber === true)
            bibtex = true;
        if (bib_backend == 'biber' && this.biber == null)
            this.print('biber backend requested but no biber module was configured, falling back to bibtex8');

        const resolved = await this.data_package_resolver.resolve(files, main_tex_path, data_packages_js);
        const filter_map = (f, return_tex_package = true) => Object.entries(resolved).filter(([tex_package, v]) => f(v)).map(([tex_package, v]) => return_tex_package ? tex_package : v.source);

        data_packages_js = Array.from(new Set(filter_map(v => v.used && v.source != 'local' && v.source != null, false))).sort();

        const tex_packages_not_resolved = filter_map(v => v.source == null);

        const fmt_packages_list = packages => '[' + (packages ? packages.toString().replaceAll(',', ', ') : '') + ']';

        console.log('resolved', resolved);
        console.log('tex_packages_not_resolved', tex_packages_not_resolved);
        console.log('data_packages_js', data_packages_js);

        this.print('TeX packages: ' + fmt_packages_list(filter_map(v => v.used)));
        this.print('TeX packages local: ' + fmt_packages_list(filter_map(v => v.source == 'local')));
        this.print('TeX packages unresolved: ' + fmt_packages_list(tex_packages_not_resolved));
        this.print('TeX packages unresolved (in local or preloaded): ' + fmt_packages_list(filter_map(v => v.used && (v.source != 'local' && !this.preload_data_packages_js.includes(v.source)))));

        this.print('Data packages used (preloaded): ' + fmt_packages_list(this.preload_data_packages_js));
        this.print('Data packages used (not preloaded): ' + fmt_packages_list(Array.from(new Set(filter_map(v => v.used && v.source != 'local' && v.source != null && !this.preload_data_packages_js.includes(v.source), false))).sort()));
        this.print('Data packages used: ' + fmt_packages_list(data_packages_js));

        if (tex_packages_not_resolved.length > 0) {
            data_packages_js = this.data_package_resolver.data_packages_js;
            this.print('Because of unresolved TeX packages, enabling all available data packages: ' + data_packages_js.sort().toString());
        }

        this.Module = this.reload_module_if_needed(this.Module == null, this.env, this.project_dir, data_packages_js);

        const Module = await this.Module;

        if (remote_endpoint)
            Module.ENV.TEXLIVE_REMOTE_ENDPOINT = remote_endpoint;

        const { FS, PATH } = Module;

        const tex_path = PATH.basename(main_tex_path), dirname = PATH.dirname(main_tex_path);

        const [xdv_path, pdf_path, log_path, aux_path, blg_path, bbl_path, idx_path, ind_path, ilg_path] =
            ['.xdv', '.pdf', '.log', '.aux', '.blg', '.bbl', '.idx', '.ind', '.ilg'].map(ext => tex_path.replace('.tex', ext));

        const verbose_args_for = key => (this.verbose_args[verbose] || this.verbose_args[BusytexPipeline.VerboseSilent])[key];
        const shell_escape_args = shell_escape ? ['--shell-escape'] : ['--no-shell-escape'];

        const xetex_cmd = ['xelatex', '-synctex=1', ...shell_escape_args, '--interaction=batchmode', '--halt-on-error', '--no-pdf', '--fmt', this.fmt.xetex, tex_path].concat(verbose_args_for('xetex'));
        const pdftex_final = ['pdflatex', '-synctex=1', ...shell_escape_args, '--interaction=nonstopmode', '--halt-on-error', '--output-format=pdf', '--fmt', this.fmt.pdftex, tex_path].concat(verbose_args_for('pdftex'));
        const pdftex_nonfinal = ['pdflatex', '-synctex=1', ...shell_escape_args, '--interaction=batchmode', '--halt-on-error', '--fmt', this.fmt.pdftex, tex_path].concat(verbose_args_for('pdftex'));
        const luahbtex_final = ['luahblatex', '-synctex=1', ...shell_escape_args, '--interaction=nonstopmode', '--halt-on-error', '--output-format=pdf', '--fmt', this.fmt.luahbtex, '--nosocket', tex_path].concat(verbose_args_for('luahbtex'));
        const luahbtex_nonfinal = ['luahblatex', '-synctex=1', ...shell_escape_args, '--interaction=nonstopmode', '--halt-on-error', '--fmt', this.fmt.luahbtex, '--nosocket', tex_path].concat(verbose_args_for('luahbtex'));
        const luatex_final = ['lualatex', '-synctex=1', ...shell_escape_args, '--interaction=nonstopmode', '--halt-on-error', '--output-format=pdf', '--fmt', this.fmt.luatex, '--nosocket', tex_path].concat(verbose_args_for('luahbtex'));
        const luatex_nonfinal = ['lualatex', '-synctex=1', ...shell_escape_args, '--interaction=nonstopmode', '--halt-on-error', '--fmt', this.fmt.luatex, '--nosocket', tex_path].concat(verbose_args_for('luahbtex'));
        const bibtex8_cmd = ['bibtex8', '--8bit'].concat(verbose_args_for('bibtex8')).concat([aux_path]);
        const makeindex_cmd = ['makeindex', idx_path];
        const xdvipdfmx_cmd = ['xdvipdfmx'].concat(verbose_args_for('xdvipdfmx')).concat(['-o', pdf_path, xdv_path]);

        const driver_cmds = {
            xetex_bibtex8_dvipdfmx: { initial: xetex_cmd, nonfinal: xetex_cmd, final: xetex_cmd, dvi: xdvipdfmx_cmd },
            pdftex_bibtex8: { initial: pdftex_nonfinal, nonfinal: pdftex_nonfinal, final: pdftex_final, dvi: null },
            luahbtex_bibtex8: { initial: luahbtex_nonfinal, nonfinal: luahbtex_nonfinal, final: luahbtex_final, dvi: null },
            luatex_bibtex8: { initial: luatex_final, nonfinal: luatex_nonfinal, final: luatex_final, dvi: null },
        };

        const { initial, nonfinal, final: final_cmd, dvi } = driver_cmds[driver];

        if (FS.analyzePath(this.project_dir).object.mount.mountpoint == this.project_dir)
            FS.unmount(this.project_dir);
        FS.mount(FS.filesystems.MEMFS, {}, this.project_dir);

        let dirs = new Set(['/', this.project_dir]);
        for (const { path, contents } of files.sort((lhs, rhs) => lhs['path'] < rhs['path'] ? -1 : 1)) {
            const absolute_path = PATH.join(this.project_dir, path);
            if (contents == null)
                this.mkdir_p(FS, PATH, absolute_path, dirs);
            else {
                this.mkdir_p(FS, PATH, PATH.dirname(absolute_path), dirs);
                FS.writeFile(absolute_path, contents);
            }
        }

        const source_dir = PATH.join(this.project_dir, dirname);
        FS.chdir(source_dir);

        const mem_header = Uint8Array.from(Module.HEAPU8.slice(0, this.mem_header_size));
        const logs = [];

        const run = (cmd, error_messages) =>
            this._run_cmd(Module, FS, cmd, error_messages, verbose, log_path, blg_path, aux_path, bbl_path, mem_header, logs);

        let exit_code = 0;
        let last_log = '';

        ({ exit_code, log: last_log } = run(initial, this.error_messages_fatal));

        if (exit_code == 0 && bibtex) {
            if (bib_backend == 'biber' && this.biber != null)
                exit_code = await this._run_biber(FS, tex_path, files, verbose_args_for('biber'), logs);
            else
                ({ exit_code } = run(bibtex8_cmd, this.error_messages_fatal));

            if (exit_code == 0 && this.read_all_text(FS, bbl_path).trim() == '') {
                this.print('$ # bibtex found no citation commands, skipping extra passes');
                bibtex = false;
            }
        }

        const makeindex_enabled = makeindex === null ? true : makeindex;
        let makeindex_active = makeindex_enabled && exit_code == 0 && FS.analyzePath(idx_path).exists && this.read_all_text(FS, idx_path).trim() != '';
        if (makeindex_active) {
            ({ exit_code } = run(makeindex_cmd, this.error_messages_fatal));
            if (exit_code == 0 && this.read_all_text(FS, ind_path).trim() == '') {
                this.print('$ # makeindex produced no index entries, skipping extra passes');
                makeindex_active = false;
            }
        } else if (makeindex === false) {
            this.print('$ # makeindex disabled by caller');
        }

        const rerun_enabled = rerun === null ? true : rerun;
        if (exit_code == 0) {
            if (rerun_enabled) {
                for (let pass = 0; pass < this.max_tex_passes; pass++) {
                    const is_last_pass = pass === this.max_tex_passes - 1;
                    const cmd = is_last_pass ? final_cmd : nonfinal;
                    const error_messages = is_last_pass ? this.error_messages_all : this.error_messages_fatal;

                    ({ exit_code, log: last_log } = run(cmd, error_messages));

                    if (exit_code != 0)
                        break;

                    if (!this._needs_rerun(last_log)) {
                        if (cmd !== final_cmd) {
                            ({ exit_code, log: last_log } = run(final_cmd, this.error_messages_all));
                        }
                        break;
                    }
                }
            } else {
                this.print('$ # rerun disabled by caller, running final pass only');
                // ({ exit_code, log: last_log } = run(final_cmd, this.error_messages_all));
            }
        }

        if (exit_code == 0 && dvi) {
            ({ exit_code } = run(dvi, this.error_messages_all));
        }

        const is_tex_log = entry => !entry.cmd.startsWith('bibtex') && !entry.cmd.startsWith('makeindex') && !entry.cmd.startsWith('xdvipdfmx');
        const last_tex_idx = logs.reduce((acc, entry, i) => is_tex_log(entry) ? i : acc, -1);
        for (let i = 0; i < logs.length; i++) {
            if (is_tex_log(logs[i]) && i !== last_tex_idx)
                logs[i].log = '';
        }

        // Falsify: do not expose document logs in the browser console.

        const pdf = exit_code == 0 ? this.read_all_bytes(FS, pdf_path) : null;
        const synctex = exit_code == 0 ? this.read_all_bytes(FS, tex_path.replace('.tex', '.synctex.gz')) : null;
        const logcat = logs.map(({ cmd, texmflog, missfontlog, log, exit_code, stdout, stderr }) => ([`$ ${cmd}`, `EXITCODE: ${exit_code}`, '', 'TEXMFLOG:', texmflog, '==', 'MISSFONTLOG:', missfontlog, '==', 'LOG:', log, '==', 'STDOUT:', stdout, '==', 'STDERR:', stderr, '======'].join('\n'))).join('\n\n');

        this.Module = this.preload == false ? null : this.Module;

        return { pdf: pdf, synctex: synctex, log: logcat, exit_code: exit_code, logs: logs };
    }
}

if (typeof self !== 'undefined') self.BusytexPipeline = BusytexPipeline;
