//
// A collection of useful resources
//
var resources = exports;

var resource = require('resource'),
    fs = require('fs'),
    path = require('path');

//
// Read "/resources/" directory
//
var _resources = fs.readdirSync(__dirname);
//
// Filter out any potential non-resource files / folders
//
_resources = _resources.filter(function (val) {
  var isResource = false;
  isResource = resource.isResource(val);
  return isResource;
});

//
// For every resource, attempt to require it
//
_resources.forEach(function (r) {
  resource.use(r);
});
