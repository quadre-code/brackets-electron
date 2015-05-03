/*jshint globalstrict:true, node:true*/

"use strict";

var fs = require("fs-extra");
var trash = require("trash");

function chmod(path, mode, callback) {
    fs.chmod(path, mode, callback);
}

function copyFile(src, dest, callback) {
    fs.copy(src, dest, callback);
}

function isNetworkDrive(path, callback) {
    // TODO: implement
    callback(null, false);
}

function makedir(path, mode, callback) {
    fs.ensureDir(path, function (err) {
        if (!err && mode) {
            fs.chmod(path, mode, callback);
        } else {
            callback(err);
        }
    });
}

function moveToTrash(path, callback) {
    trash([path], callback);
}

function readdir(path, callback) {
    fs.readdir(path, callback);
}

function readFile(path, encoding, callback) {
    fs.readFile(path, {
        encoding: encoding || "utf8"
    }, callback);
}

function rename(oldPath, newPath, callback) {
    fs.rename(oldPath, newPath, callback);
}

function showOpenDialog(allowMultipleSelection, chooseDirectory, title, initialPath, fileTypes, callback) {
    callback(new Error("showOpenDialog is not implemented"));
}

function showSaveDialog(title, initialPath, proposedNewFilename, callback) {
    callback(new Error("showSaveDialog is not implemented"));
}

function stat(path, callback) {
    fs.lstat(path, function (err, stat) {
        if (stat) {
            // TODO: Implement realPath. If "filename" is a symlink,
            // realPath should be the actual path to the linked object.
            if (stat.isSymbolicLink()) {
                return callback(new Error("realPath for symbolic link is not implemented in appshell.fs.stat"));
            }
            stat.realPath = null;
        }
        callback(err, stat);
    });
}

function unlink(path, callback) {
    fs.unlink(path, callback);
}

function writeFile(path, data, encoding, callback) {
    fs.writeFile(path, data, {
        encoding: encoding || "utf8"
    }, callback);
}

module.exports = {
    chmod: chmod,
    copyFile: copyFile,
    isNetworkDrive: isNetworkDrive,
    makedir: makedir,
    moveToTrash: moveToTrash,
    readdir: readdir,
    readFile: readFile,
    rename: rename,
    showOpenDialog: showOpenDialog,
    showSaveDialog: showSaveDialog,
    stat: stat,
    unlink: unlink,
    writeFile: writeFile
};