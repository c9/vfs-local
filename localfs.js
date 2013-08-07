var fs = require("fs");
var net = require("net");
var childProcess = require("child_process");
var constants = require("constants");
var join = require("path").join;
var pathResolve = require("path").resolve;
var pathNormalize = require("path").normalize;
var dirname = require("path").dirname;
var basename = require("path").basename;
var Stream = require("stream").Stream;
var getMime = require("simple-mime")("application/octet-stream");
var vm = require("vm");
var exists = fs.exists || require("path").exists;
var crypto = require("crypto");

module.exports = function setup(fsOptions) {
    var pty;
    if (!fsOptions.nopty) {
        try {
            if (fsOptions.local) throw new Error();
            pty = fsOptions.local ? require('pty.nw.js') : require('pty.js');
        } catch(e) {
            console.warn("unable to initialize " 
                + (fsOptions.local ? "pty.nw.js" : "pty.js") + ":");
            console.warn(e);
            pty = function(){};
        }
    }
    else {
        pty = function(){
            console.log("PTY is not supported.");
        };
    }

    // Get the separator char. In Node 0.8, we can use path.sep instead
    var pathSep = pathNormalize("/");
    
    var METAPATH   = fsOptions.metapath;
    var WSMETAPATH = fsOptions.wsmetapath;
    var TESTING    = fsOptions.testing;

    // Check and configure options
    var root = fsOptions.root;
    if (!root) throw new Error("root is a required option");
    root = pathNormalize(root);
    
    if (pathSep == "/" && root[0] !== "/") throw new Error("root path must start in /");
    if (root[root.length - 1] !== pathSep) root += pathSep;
    // root = "/" doesn't work on windows
    if (pathSep == "\\" && root == "/") root = "";

    var base = root.substr(0, root.length - 1);
    // root = "/" doesn't work on windows
    if (pathSep == "\\" && root == pathSep) root = "";

    var umask = fsOptions.umask || 0750;
    if (fsOptions.hasOwnProperty('defaultEnv')) {
        fsOptions.defaultEnv.__proto__ = process.env;
    } else {
        fsOptions.defaultEnv = process.env;
    }

    // Storage for extension APIs
    var apis = {};
    // Storage for event handlers
    var handlers = {};

    // Export the API
    var vfs = {
        // File management
        resolve: resolve,
        stat: stat,
        readfile: readfile,
        readdir: readdir,
        mkfile: mkfile,
        mkdir: mkdir,
        mkdirP: mkdirP,
        rmfile: rmfile,
        rmdir: rmdir,
        rename: rename,
        copy: copy,
        symlink: symlink,

        // Retrieve Metadata
        metadata: metadata,

        // Wrapper around fs.watch or fs.watchFile
        watch: watch,

        // Network connection
        connect: connect,

        // Process Management
        spawn: spawn,
        execFile: execFile,

        // Basic async event emitter style API
        on: on,
        off: off,
        emit: emit,

        // Extending the API
        extend: extend,
        unextend: unextend,
        use: use
    };

////////////////////////////////////////////////////////////////////////////////

    // Realpath a file and check for access
    // callback(err, path)
    function resolvePath(path, options, callback) {
        if (!callback) {
            callback = options;
            options = {};
        }
        
        var alreadyRooted = options.alreadyRooted;
        var checkSymlinks = options.checkSymlinks === undefined 
            ? true : options.checkSymlinks;
        var isHome        = false;
        
        if (checkSymlinks === undefined)
            checkSymlinks = true;
        if (path.substr(0, 2) == "~/") {
            isHome = true;
            path = process.env.HOME + path.substr(1);
        }
        else if (!alreadyRooted) 
            path = join(root, path);

        if (checkSymlinks && fsOptions.checkSymlinks && !alreadyRooted) 
            fs.realpath(path, check);
        else check(null, path);

        function check(err, path) {
            if (err) return callback(err);
            
            if (!options.nocheck) {
                if (!(path === base || path.substr(0, root.length) === root)
                  && !isHome) {
                    err = new Error("EACCESS: '" + path + "' not in '" + root + "'");
                    err.code = "EACCESS";
                    return callback(err);
                }
            }
            callback(null, path);
        }
    }

    // A wrapper around fs.open that enforces permissions and gives extra data in
    // the callback. (err, path, fd, stat)
    function open(path, flags, mode, callback) {
        resolvePath(path, function (err, path) {
            if (err) return callback(err);
            fs.open(path, flags, mode, function (err, fd) {
                if (err) return callback(err);
                fs.fstat(fd, function (err, stat) {
                    if (err) return callback(err);
                    callback(null, path, fd, stat);
                });
            });
        });
    }

    // This helper function doesn't follow node conventions in the callback,
    // there is no err, only entry.
    function createStatEntry(file, fullpath, callback) {
        fs.lstat(fullpath, function (err, stat) {
            var entry = {
                name: file
            };

            if (err) {
                entry.err = err;
                return callback(entry);
            } else {
                entry.size = stat.size;
                entry.mtime = stat.mtime.valueOf();

                if (stat.isDirectory()) {
                    entry.mime = "inode/directory";
                } else if (stat.isBlockDevice()) entry.mime = "inode/blockdevice";
                else if (stat.isCharacterDevice()) entry.mime = "inode/chardevice";
                else if (stat.isSymbolicLink()) entry.mime = "inode/symlink";
                else if (stat.isFIFO()) entry.mime = "inode/fifo";
                else if (stat.isSocket()) entry.mime = "inode/socket";
                else {
                    entry.mime = getMime(fullpath);
                }

                if (!stat.isSymbolicLink()) {
                    return callback(entry);
                }
                fs.readlink(fullpath, function (err, link) {
                    if (entry.name == link) {
                        entry.linkStatErr = "ELOOP: recursive symlink";
                        return callback(entry);
                    }

                    if (err) {
                        entry.linkErr = err.stack;
                        return callback(entry);
                    }
                    entry.link = link;
                    resolvePath(pathResolve(dirname(fullpath), link), {alreadyRooted: true}, function (err, newpath) {
                      if (err) {
                          entry.linkStatErr = err;
                          return callback(entry);
                      }
                      createStatEntry(basename(newpath), newpath, function (linkStat) {
                          entry.linkStat = linkStat;
                          linkStat.fullPath = newpath.substr(base.length) || "/";
                          return callback(entry);
                      });
                    });
                });
            }
        });
    }

    // Common logic used by rmdir and rmfile
    function remove(path, fn, callback) {
        var meta = {};
        resolvePath(path, function (err, realpath) {
            if (err) return callback(err);
            fn(realpath, function (err) {
                if (err) return callback(err);
                
                // Remove metadata
                resolvePath(WSMETAPATH + path, function (err, realpath) {
                    if (err) return callback(null, meta);
                    
                    fn(realpath, function(){
                        return callback(null, meta);
                    });
                });
            });
        });
    }

////////////////////////////////////////////////////////////////////////////////

    function resolve(path, options, callback) {
        resolvePath(path, options, function (err, path) {
            if (err) return callback(err);
            callback(null, { path: path });
        });
    }

    function stat(path, options, callback) {

        // Make sure the parent directory is accessable
        resolvePath(dirname(path), function (err, dir) {
            if (err) return callback(err);
            var file = basename(path);
            path = join(dir, file);
            createStatEntry(file, path, function (entry) {
                if (entry.err) {
                    return callback(entry.err);
                }
                callback(null, entry);
            });
        });
    }
    
    function metadata(path, data, callback) {
        var dirpath = (path.substr(0,5) == "/_/_/" 
            ? METAPATH + dirname(path.substr(4))
            : WSMETAPATH + "/" + dirname(path));
        resolvePath(dirpath, function (err, dir) {
            if (err) return callback(err);
            
            var file = basename(path);
            path = join(dir, file);
            
            execFile("mkdir", { args: ["-p", dir] }, function(err){
                if (err) return callback(err);
                
                fs.writeFile(path, JSON.stringify(data), {}, function(err){
                    if (err) return callback(err);
                    callback(null, {});
                });
            });
        });
    }

    function readfile(path, options, callback) {

        var meta = {};

        open(path, "r", umask & 0666, function (err, path, fd, stat) {
            if (err) return callback(err);
            if (stat.isDirectory()) {
                fs.close(fd);
                err = new Error("EISDIR: Requested resource is a directory");
                err.code = "EISDIR";
                return callback(err);
            }

            // Basic file info
            meta.mime = getMime(path);
            meta.size = stat.size;
            meta.etag = calcEtag(stat);

            // ETag support
            if ((TESTING || stat.mtime % 1000) && options.etag === meta.etag) {
                meta.notModified = true;
                fs.close(fd);
                return callback(null, meta);
            }

            // Range support
            if (options.hasOwnProperty('range') && !(options.range.etag && options.range.etag !== meta.etag)) {
                var range = options.range;
                var start, end;
                if (range.hasOwnProperty("start")) {
                    start = range.start;
                    end = range.hasOwnProperty("end") ? range.end : meta.size - 1;
                }
                else {
                    if (range.hasOwnProperty("end")) {
                        start = meta.size - range.end;
                        end = meta.size - 1;
                    }
                    else {
                        meta.rangeNotSatisfiable = "Invalid Range";
                        fs.close(fd);
                        return callback(null, meta);
                    }
                }
                if (end < start || start < 0 || end >= stat.size) {
                    meta.rangeNotSatisfiable = "Range out of bounds";
                    fs.close(fd);
                    return callback(null, meta);
                }
                options.start = start;
                options.end = end;
                meta.size = end - start + 1;
                meta.partialContent = { start: start, end: end, size: stat.size };
            }

            // HEAD request support
            if (options.hasOwnProperty("head")) {
                fs.close(fd);
                return callback(null, meta);
            }

            // Read the file as a stream
            try {
                options.fd = fd;
                meta.stream = new fs.ReadStream(path, options);
            } catch (err) {
                fs.close(fd);
                return callback(err);
            }
            callback(null, meta);
        });
    }

    function readdir(path, options, callback) {
        var meta = {};

        resolvePath(path, function (err, path) {
            if (err) return callback(err);
            fs.stat(path, function (err, stat) {
                if (err) return callback(err);
                if (!stat.isDirectory()) {
                    err = new Error("ENOTDIR: Requested resource is not a directory");
                    err.code = "ENOTDIR";
                    return callback(err);
                }

                // ETag support
                meta.etag = calcEtag(stat);
                if ((TESTING || stat.mtime % 1000) && options.etag === meta.etag) {
                    meta.notModified = true;
                    return callback(null, meta);
                }

                fs.readdir(path, function (err, files) {
                    if (err) return callback(err);
                    if (options.head) {
                        return callback(null, meta);
                    }
                    var stream = new Stream();
                    stream.readable = true;
                    var paused;
                    stream.pause = function () {
                        if (paused === true) return;
                        paused = true;
                    };
                    stream.resume = function () {
                        if (paused === false) return;
                        paused = false;
                        getNext();
                    };
                    meta.stream = stream;
                    callback(null, meta);
                    var index = 0;
                    stream.resume();
                    function getNext() {
                        if (index === files.length) return done();
                        var file = files[index++];
                        var fullpath = join(path, file);

                        createStatEntry(file, fullpath, function onStatEntry(entry) {
                            stream.emit("data", entry);

                            if (!paused) {
                                getNext();
                            }
                        });
                    }
                    function done() {
                        stream.emit("end");
                    }
                });
            });
        });
    }
    
    // This is used for creating / overwriting files.  It always creates a new tmp
    // file and then renames to the final destination.
    // It will copy the properties of the existing file is there is one.
    function mkfile(path, options, realCallback) {
        var meta = {};
        var called;
        var callback = function (err) {
            if (called) {
                if (err) {
                    if (meta.stream) meta.stream.emit("error", err);
                    else console.error(err.stack);
                }
                else if (meta.stream) meta.stream.emit("saved");
                return;
            }
            called = true;
            return realCallback(err, meta);
        };

        if (options.stream && !options.stream.readable) {
            return callback(new TypeError("options.stream must be readable."));
        }

        // Pause the input for now since we're not ready to write quite yet
        var readable = options.stream;
        if (readable) {
            if (readable.pause) readable.pause();
            var buffer = [];
            readable.on("data", onData);
            readable.on("end", onEnd);
        }

        function onData(chunk) {
            buffer.push(["data", chunk]);
        }
        function onEnd() {
            buffer.push(["end"]);
        }
        function error(err) {
            resume();
            if (tempPath) {
                fs.unlink(tempPath, callback.bind(null, err));
            }
            else
                return callback(err);
        }
        
        function resume() {
            if (readable) {
                // Stop buffering events and playback anything that happened.
                readable.removeListener("data", onData);
                readable.removeListener("end", onEnd);

                buffer.forEach(function (event) {
                    readable.emit.apply(readable, event);
                });
                // Resume the input stream if possible
                if (readable.resume) readable.resume();
            }
        }
        
        var tempPath;
        var resolvedPath = "";

        mkdir();

        function mkdir() {
            if (options.parents) {
                mkdirP(dirname(path), {}, function(err) {
                    if (err) return error(err);
                    resolve();
                });
            }
            else {
                resolve();
            }
        }

        // Make sure the user has access to the directory and get the real path.
        function resolve() {
            resolvePath(path, function (err, _resolvedPath) {
                if (err) {
                    if (err.code !== "ENOENT") {
                        return error(err);
                    }
                    // If checkSymlinks is on we'll get an ENOENT when creating a new file.
                    // In that case, just resolve the parent path and go from there.
                    resolvePath(dirname(path), function (err, dir) {
                        if (err) return error(err);
                        resolvedPath = join(dir, basename(path));
                        createTempFile();
                    });
                    return;
                }
                
                resolvedPath = _resolvedPath;
                createTempFile();
            });
        }
        
        
        function createTempFile() {
            tempPath = tmpFile(dirname(resolvedPath), "." + basename(resolvedPath) + "-", "~");
            
            var mode = options.mode || umask & 0666;
            fs.stat(resolvedPath, function(err, stat) {
                if (err && err.code !== "ENOENT") return error(err);
                
                var uid = process.getuid ? process.getuid() : 0;
                var gid = process.getgid ? process.getgid() : 0;
                
                if (stat) {
                    mode = stat.mode & 0777;
                    uid = stat.uid;
                    gid = stat.gid;
                }

                // node 0.8.x adds a "wx" shortcut, but since it's not in 0.6.x we use the
                // longhand here.
                var flags = constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL;
                fs.open(tempPath, flags, mode, function (err, fd) {
                    if (err) return error(err);
                    
                    fs.fchown(fd, uid, gid, function(err) {
                        fs.close(fd);
                        if (err) return error(err);
                        
                        pipe(fs.WriteStream(tempPath, {
                            encoding: options.encoding || null,
                            mode: mode
                        }));
                    });
                });
            });
        }

        function pipe(writable) {
            var hadError;
            
            if (readable) {
                readable.pipe(writable);
            }
            else {
                writable.on('open', function () {
                    if (hadError) return;
                    meta.stream = writable;
                    callback();
                });
            }
            writable.on('error', function (err) {
                hadError = true;
                error(err);
            });
            writable.on('close', function () {
                if (hadError) return;
                swap();
            });

            resume();
        }
        
        function swap() {
            fs.rename(tempPath, resolvedPath, function (err) {
                if (err) return error(err);
                callback();
            });
        }
    }

    function mkdirP(path, options, callback) {
        resolvePath(path, { checkSymlinks: false}, function(err, dir) {
            if (err) return callback(err);
            
            exists(dir, function(exists) {
                if (exists) return callback(null, {}); 
                execFile("mkdir", { args: ["-p", dir] }, function(err) {
                    if (err && err.message.indexOf("exists") > -1)
                        callback({"code": "EEXIST", "message": err.message});
                    else
                        callback(null, {});
                });
            });
        });
    }

    function mkdir(path, options, callback) {
        var meta = {};
        
        if (options.parents)
            return mkdirP(path, options, callback);
            
        // Make sure the user has access to the parent directory and get the real path.
        resolvePath(dirname(path), function (err, dir) {
            if (err) return callback(err);
            path = join(dir, basename(path));
            fs.mkdir(path, function (err) {
                if (err) return callback(err);
                callback(null, meta);
            });
        });
    }

    function rmfile(path, options, callback) {
        remove(path, fs.unlink, callback);
    }

    function rmdir(path, options, callback) {
        if (options.recursive) {
            remove(path, function(path, callback) {
                execFile("rm", {args: ["-rf", path]}, callback);
            }, callback);
        }
        else {
            remove(path, fs.rmdir, callback);
        }
    }

    function rename(path, options, callback) {
        var from, to;
        if (options.from) {
            from = options.from; to = path;
        }
        else if (options.to) {
            from = path; to = options.to;
        }
        else {
            return callback(new Error("Must specify either options.from or options.to"));
        }
        var meta = {};
        // Get real path to source
        resolvePath(from, function (err, frompath) {
            if (err) return callback(err);
            // Get real path to target dir
            resolvePath(dirname(to), function (err, dir) {
                if (err) return callback(err);
                var topath = join(dir, basename(to));
                
                exists(topath, function(exists){
                    if (options.overwrite || !exists) {
                        // Rename the file
                        fs.rename(frompath, topath, function (err) {
                            if (err) return callback(err);
                            
                            // Rename metadata
                            if (options.metadata !== false) {
                                rename(WSMETAPATH + from, {
                                    to: WSMETAPATH + to,
                                    metadata: false
                                }, function(err){
                                    callback(null, meta);
                                });
                            }
                        });
                    }
                    else {
                        var err = new Error("File already exists.");
                        err.code = "EEXIST";
                        callback(err);
                    }
                });
            });
        });
    }

    function copy(path, options, callback) {
        var from, to;
        if (options.from) {
            from = options.from; to = path;
        }
        else if (options.to) {
            from = path; to = options.to;
        }
        else {
            return callback(new Error("Must specify either options.from or options.to"));
        }
        
        if (!options.overwrite) {
            resolvePath(to, function(err, path){
                if (err) {
                    if (err.code == "ENOENT")
                        return innerCopy(from, to);
                    
                    return callback(err);
                }
                
                fs.stat(path, function(err, stat){
                    if (!err && stat && !stat.err) {
                        // TODO: this logic should be pushed into the application code
                        var path = to.replace(/(?:\.([\d+]))?(\.[^\.]*)?$/, function(m, d, e){
                            return "." + (parseInt(d, 10)+1 || 1) + (e ? e : "");
                        });
                        
                        copy(from, {
                            to        : path, 
                            overwrite : false, 
                            recursive : options.recursive
                        }, callback);
                    }
                    else {
                        innerCopy(from, to);
                    }
                });
            });
        }
        else {
            innerCopy(from, to);
        }
        
        function innerCopy(from, to) {
            if (options.recursive) {
                resolvePath(from, function(err, rFrom){
                    resolvePath(to, function(err, rTo){
                        spawn("cp", {
                            args: [ "-a", rFrom, rTo ],
                            stdoutEncoding : "utf8",
                            stderrEncoding : "utf8",
                            stdinEncoding : "utf8"
                        }, function(err, child){
                            if (err) return callback(err);
                            
                            var proc = child.process;
                            var hasError;
                            
                            proc.stderr.on("data", function(d){
                                if (d) {
                                    hasError = true;
                                    callback(new Error(d));
                                }
                            });
                            proc.stdout.on("end", function() {
                                if (!hasError)
                                    callback(null, { to: to, meta: null });
                            });
                        });
                    });
                });
            }
            else {
                readfile(from, {}, function (err, meta) {
                    if (err) return callback(err);
                    mkfile(to, {stream: meta.stream}, function (err, meta) {
                        callback(err, {
                            to: to,
                            meta: meta
                        });
                    });
                });
            }
        }
    }

    function symlink(path, options, callback) {
        if (!options.target) return callback(new Error("options.target is required"));
        var meta = {};
        // Get real path to target dir
        resolvePath(dirname(path), function (err, dir) {
            if (err) return callback(err);
            path = join(dir, basename(path));
            
            resolvePath(options.target, function (err, target) {
                if (err) return callback(err);
                fs.symlink(target, path, function (err) {
                    if (err) return callback(err);
                    callback(null, meta);
                });
            });
        });
    }

    function WatcherWrapper(path, options){
        var listeners  = [];
        var persistent = options.persistent;
        var watcher;
        
        function watch(){
            if (options.file) {
                watcher = fs.watchFile(path, { persistent: false }, function () {});
                watcher.close = function () { fs.unwatchFile(path); };
            }
            else {
                watcher = fs.watch(path, { persistent: false }, function () {});
            }
            
            watcher.on("change", listen);
        }
        
        function listen(event, filename){
            listeners.forEach(function(fn){
                fn(event, filename);
            });
            
            if (persistent !== false) {
                // This timeout fixes an eternal loop that can occur with watchers
                setTimeout(function(){
                    try{ 
                        watcher.close();
                        watch(); 
                    } catch(e) { }
                });
            }
        }
        
        this.close = function(){
            listeners  = [];
            watcher.removeListener("change", listen);
            watcher.close();
        };
        
        this.on = function(name, fn){
            if (name != "change")
                watcher.on.apply(watcher, arguments);
            else {
                listeners.push(fn);
            }
        };
        
        this.removeListener = function(name, fn){
            if (name != "change")
                watcher.removeListener.apply(watcher, arguments);
            else {
                listeners.splice(listeners.indexOf(fn), 1);
            }
        };
        
        watch();
    }

    function watch(path, options, callback) {
        var meta = {};
        resolvePath(path, function (err, path) {
            if (err) return callback(err);
            
            try {
                meta.watcher = new WatcherWrapper(path, options);
            } catch (e) {
                return callback(e);
            }
            
            callback(null, meta);
        });
    }

    function connect(port, options, callback) {
        var retries = options.hasOwnProperty('retries') ? options.retries : 5;
        var retryDelay = options.hasOwnProperty('retryDelay') ? options.retryDelay : 50;
        tryConnect();
        function tryConnect() {
            var socket = net.connect(port, process.env.OPENSHIFT_DIY_IP || "localhost", function () {
                if (options.hasOwnProperty('encoding')) {
                    socket.setEncoding(options.encoding);
                }
                callback(null, {stream:socket});
            });
            socket.once("error", function (err) {
                if (err.code === "ECONNREFUSED" && retries) {
                    setTimeout(tryConnect, retryDelay);
                    retries--;
                    retryDelay *= 2;
                    return;
                }
                return callback(err);
            });
        }
    }

    function spawn(executablePath, options, callback) {
        var args = options.args || [];

        if (options.hasOwnProperty('env')) {
            options.env.__proto__ = fsOptions.defaultEnv;
        } else {
            options.env = fsOptions.defaultEnv;
        }
        if (options.cwd && options.cwd.charAt(0) == "~")
            options.cwd = options.env.HOME + options.cwd.substr(1);
        
        resolvePath(executablePath, { 
            nocheck       : 1,
            alreadyRooted : true
        }, function(err, path){
            if (err) return callback(err);
            
            var child;
            try {
                child = childProcess.spawn(path, args, options);
            } catch (err) {
                return callback(err);
            }
            if (options.resumeStdin) child.stdin.resume();
            if (options.hasOwnProperty('stdoutEncoding')) {
                child.stdout.setEncoding(options.stdoutEncoding);
            }
            if (options.hasOwnProperty('stderrEncoding')) {
                child.stderr.setEncoding(options.stderrEncoding);
            }
            
            // node 0.10.x emits error events if the file does not exist
            child.on("error", function(err) {
              child.emit("exit", 127);
            });
    
            callback(null, {
                process: child
            });
        });
    }
    
    function ptyspawn(executablePath, options, callback) {
        var args = options.args || [];
        delete options.args;
        
        if (options.hasOwnProperty('env')) {
            options.env.__proto__ = fsOptions.defaultEnv;
        } else {
            options.env = fsOptions.defaultEnv;
        }
    
        // Pty is only reading from the object itself;
        var env = {};
        for (var prop in options.env) {
            if (prop == "TMUX") continue;
            env[prop] = options.env[prop];
        }
        options.env = env;
        if (options.cwd && options.cwd.charAt(0) == "~")
            options.cwd = env.HOME + options.cwd.substr(1);
        
        resolvePath(executablePath, { 
            nocheck       : 1,
            alreadyRooted : true
        }, function(err, path){
            if (err) return callback(err);
    
            var proc;
            try {
                proc = pty.spawn(path, args, options);
                proc.on("error", function(){
                    // Prevent PTY from throwing an error;
                    // I don't know how to test and the src is funky because
                    // it tests for .length < 2. Who is setting the other event?
                });
            } catch (err) {
                return callback(err);
            }
            
            callback(null, {
                pty: proc
            });
        });
    }

    function execFile(executablePath, options, callback) {
        if (options.hasOwnProperty('env')) {
            options.env.__proto__ = fsOptions.defaultEnv;
        } else {
            options.env = fsOptions.defaultEnv;
        }
        if (options.cwd && options.cwd.charAt(0) == "~")
            options.cwd = options.env.HOME + options.cwd.substr(1);
        
        resolvePath(executablePath, {
            nocheck       : 1,
            alreadyRooted : true
        }, function(err, path){
            if (err) return callback(err);
            
            childProcess.execFile(path, options.args || [], 
              options, function (err, stdout, stderr) {
                if (err) {
                    err.stderr = stderr;
                    err.stdout = stdout;
                    return callback(err);
                }
    
                callback(null, {
                    stdout: stdout,
                    stderr: stderr
                });
            });
        });
    }

    function on(name, handler, callback) {
        if (!handlers[name]) handlers[name] = [];
        handlers[name].push(handler);
        callback && callback();
    }

    function off(name, handler, callback) {
        var list = handlers[name];
        if (list) {
            var index = list.indexOf(handler);
            if (index >= 0) {
                list.splice(index, 1);
            }
        }
        callback && callback();
    }

    function emit(name, value, callback) {
        var list = handlers[name];
        if (list) {
            for (var i = 0, l = list.length; i < l; i++) {
                list[i](value);
            }
        }
        callback && callback();
    }

    function extend(name, options, callback) {

        var meta = {};
        // Pull from cache if it's already loaded.
        if (!options.redefine && apis.hasOwnProperty(name)) {
            var err = new Error("EEXIST: Extension API already defined for " + name);
            err.code = "EEXIST";
            return callback(err);
        }

        var fn;

        // The user can pass in a path to a file to require
        if (options.file) {
            try { fn = require(options.file); }
            catch (err) { return callback(err); }
            fn(vfs, onEvaluate);
        }

        // User can pass in code as a pre-buffered string
        else if (options.code) {
            try { fn = evaluate(options.code); }
            catch (err) { return callback(err); }
            fn(vfs, onEvaluate);
        }

        // Or they can provide a readable stream
        else if (options.stream) {
            consumeStream(options.stream, function (err, code) {
                if (err) return callback(err);
                var fn;
                try {
                    fn = evaluate(code);
                } catch(err) {
                    return callback(err);
                }
                fn(vfs, onEvaluate);
            });
        }

        else {
            return callback(new Error("must provide `file`, `code`, or `stream` when cache is empty for " + name));
        }

        function onEvaluate(err, exports) {
            if (err) {
                return callback(err);
            }
            exports.names = Object.keys(exports);
            exports.name = name;
            apis[name] = exports;
            meta.api = exports;
            callback(null, meta);
        }

    }

    function unextend(name, options, callback) {
        delete apis[name];
        callback(null, {});
    }

    function use(name, options, callback) {
        var api = apis[name];
        if (!api) {
            var err = new Error("ENOENT: There is no API extension named " + name);
            err.code = "ENOENT";
            return callback(err);
        }
        callback(null, {api:api});
    }

////////////////////////////////////////////////////////////////////////////////

    return vfs;

};

// Consume all data in a readable stream and call callback with full buffer.
function consumeStream(stream, callback) {
    var chunks = [];
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    function onData(chunk) {
        chunks.push(chunk);
    }
    function onEnd() {
        cleanup();
        callback(null, chunks.join(""));
    }
    function onError(err) {
        cleanup();
        callback(err);
    }
    function cleanup() {
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        stream.removeListener("error", onError);
    }
}

// node-style eval
function evaluate(code) {
    var exports = {};
    var module = { exports: exports };
    vm.runInNewContext(code, {
        require: require,
        exports: exports,
        module: module,
        console: console,
        global: global,
        process: process,
        Buffer: Buffer,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval
    }, "dynamic-" + Date.now().toString(36), true);
    return module.exports;
}

// Calculate a proper etag from a nodefs stat object
function calcEtag(stat) {
  return (stat.isFile() ? '': 'W/') + '"' + (stat.ino || 0).toString(36) + "-" + stat.size.toString(36) + "-" + stat.mtime.valueOf().toString(36) + '"';
}

function uid(length) {
    return (crypto
        .randomBytes(length)
        .toString("base64")
        .slice(0, length)
        .replace(/[+\/]+/g, "")
    );
}

function tmpFile(baseDir, prefix, suffix) {
    return join(baseDir, [prefix || "", uid(20), suffix || ""].join(""));
}
