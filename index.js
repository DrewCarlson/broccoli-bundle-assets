var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var cheerio = require('cheerio');
var walkSync = require('walk-sync');
var mapSeries = require('promise-map-series');
var Writer = require('broccoli-writer');
var helpers = require('broccoli-kitchen-sink-helpers');

// Asset bundling plugin.
//
// Takes just a tree, and rewrites script and stylesheet link-tags, bundling
// all contents into a single file. Tags that list non-existant files or
// external URLs are kept as-is.
//
// The JavaScript and CSS bundles are named after the HTML file, with a
// different extension. All other JavaScript and CSS files are discarded.
//
// An optional second argument is a list for regular expressions for JavaScript
// and CSS files to preserve.
//
// This plugin does not account for alternative stylesheets, or media queries
// in link-tag attributes.
var BundleAssets = function(tree, subjects) {
    if (!(this instanceof BundleAssets))
        return new BundleAssets(tree, subjects);

    this.tree = tree;
    this.subjects = subjects || [];
};
BundleAssets.prototype = Object.create(Writer.prototype);

var htmlRe = /\.html$/;
var discardRe = /\.(js|css)$/;
var isUrlRe = /^\w+:\/\//;

BundleAssets.prototype.write = function(readTree, dst) {
    var self = this;
    return readTree(self.tree)
    .then(function(src) {
        return mapSeries(walkSync(src), function(p) {
            var i = path.join(src, p);
            var o = path.join(dst, p);

            // Rebuild directories in the output.
            if (p.slice(-1) === '/')
                return mkdirp.sync(o);

            // Process HTML files.
            if (htmlRe.test(p) && ~self.subjects.indexOf(p)) {
                return self.processHtml(i, o, src);
            } else {
                return self.preserveHtml(i, o, src);
            }
        });
    });
};

BundleAssets.prototype.preserveHtml = function(i, o, iRoot) {
    fs.writeFileSync(o, fs.readFileSync(i, 'utf-8'));
}

BundleAssets.prototype.processHtml = function(i, o, iRoot) {
    var file, tag;

    var name = path.basename(i).replace(htmlRe, '');
    var iBase = path.dirname(i);
    var oBase = path.dirname(o);

    var html = fs.readFileSync(i, 'utf-8');
    var $ = cheerio.load(html);

    // Walk elements matching the selector, and look for the files in the given
    // attribute. The result is a list of tags and their files' contents.
    function collectFiles(sel, attr, cb) {
        var files = [];
        var tags = $(sel).filter(function() {
            var s = $(this).attr(attr);

            if (!s || isUrlRe.test(s))
                return false;

            var f = s;
            if (s.charAt(0) === '/')
                f = path.join(iRoot, s);
            else
                f = path.join(iBase, s);

            if (!fs.existsSync(f))
                return false;

            files.push({
                path: f,
                data: fs.readFileSync(f, 'utf-8')
            });
            return true;
        });
        cb(tags, files);
    }

    // Bundle all js content and create a new script tag.
    collectFiles('script', 'src', function(tags, files) {
        if (tags.length === 0) return;
        tags.remove();

        var file = name + '.js';
        var data = files.map(function(f) { return f.data; }).join('\n');

        $('head').append("<script type='text/javascript'>" + data + "</script>");
    });

    // Bundle all css content and create a new link tag.
    collectFiles('link[rel="stylesheet"]', 'href', function(tags, files) {
        if (tags.length === 0) return;
        tags.remove();

        var file = name + '.css';
        var data = files.map(function(f) {
            // Rewrite relative URLs.
            var dir = path.dirname(f.path);
            return f.data.replace(/url\(\s*['"]?(.+?)['"]?\s*\)/g, function(match, ref) {
                if (ref[0] === '/' || /https?:/.test(ref)) return match;
                ref = path.resolve(dir, ref);
                ref = path.relative(iBase, ref);
                return 'url(' + JSON.stringify(ref) + ')';
            });
        }).join('\n');

        $('head').append("<style type='text/css'>" + data + "</style>");
    });

    // Write processed HTML.
    fs.writeFileSync(o, $.html());
};

module.exports = BundleAssets;
