# VFS Local

[![Build Status](https://secure.travis-ci.org/c9/vfs-local.png?branch=master)](http://travis-ci.org/c9/vfs-local)

VFS is an abstract interface for working with systems.  This module is the reference implementation and provides a vfs interface to the local system using node apis.  This is also often used in conjuction with `vfs-socket` to provide the vfs interface to a remote system over any kind of network socket.

## setup(fsOptions) -> vfs

This is the main exports of the module.  It's a function that returns a vfs-local instance.

The `fsOptions` argument is an object that can contain the following properties:

 - `root`: Root path to mount the vfs.  All fs operations are done relative to this root.  Access outside this root is not allowed.
 - `checkSymlinks`: Normally paths are resolved using pure string manipulation.  This options will aditionally realpath any symlinks to get the absolute path on the filesystem.  Pratically it prevents you from using symlinks that point outside the `root`.
 - `umask`: Default umask for creating files (defaults to 0750)
 - `defaultEnv`: A shallow hash of env values to inject into child processes.

## vfs.resolve(path, options, callback(err, meta))

This takes a virtual path as `path` and returns the resolved path in the real filesystem as `meta.path` in the callback.

This function has one option `options.alreadyRooted` that tells resolve to not prefix the path with the vfs root.

## vfs.stat(path, options, callback(err, stat))

Loads the stat information for a single path entity as `stat` in the callback.  This is a javascript object with the following fields:

 - `name`: The basename of the file path (eg: file.txt).
 - `size`: The size of the entity in bytes.
 - `mtime`: The mtime of the file in ms since epoch.
 - `mime`: The mime type of the entity.  Folders will have a mime that matches `/(directory|folder)$/`.  This vfs implementation will give `inode/directory` for directories.
 - `link`: If the file is a symlink, this property will contain the link data as a string.
 - `linkStat`: The stat information for what the link points to.
   - `fullPath`: The link stat object will have an additional property that's the resolved path relative to the vfs root.

## vfs.readfile(path, options, callback)

TODO: document this

## vfs.readdir(path, options, callback)

TODO: document this

## vfs.mkfile(path, options, callback)

TODO: document this

## vfs.mkdir(path, options, callback)

TODO: document this

## vfs.rmfile(path, options, callback)

TODO: document this

## vfs.rmdir(path, options, callback)

TODO: document this

## vfs.rename(path, options, callback)

TODO: document this

## vfs.copy(path, options, callback)

TODO: document this

## vfs.symlink(path, options, callback)

TODO: document this

## vfs.watch(path, options, callback)

TODO: document this

## vfs.connect(port, options, callback)

TODO: document this

## vfs.connect(port, options, callback)

TODO: document this

## vfs.spawn(executablePath, options, callback)

TODO: document this

## vfs.execFile(executablePath, options, callback)

TODO: document this

## vfs.on(event, handler, callback)

TODO: document this

## vfs.off(event, handler, callback)

TODO: document this

## vfs.emit(event, value, callback)

TODO: document this

## vfs.extend(name, options, callback)

TODO: document this

## vfs.unextend(name, options, callback)

TODO: document this

## vfs.use(name, options, callback)

TODO: document this
