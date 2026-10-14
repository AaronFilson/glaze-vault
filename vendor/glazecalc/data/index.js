// The standard materials, additives and advice every installation starts with.
// Each file holds one MongoDB Extended JSON document per line (NDJSON), so ids
// such as { "$oid": ... } come back as real ObjectIds. The file names match the
// collections Mongoose uses for the models.
const fs = require('fs');
const path = require('path');
const { EJSON } = require('mongoose').mongo.BSON;

exports.COLLECTIONS = ['materials', 'additives', 'advice'];

/** The standard documents for one collection. */
exports.load = (collection) =>
  fs
    .readFileSync(path.join(__dirname, collection + '.ndjson'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => EJSON.parse(line));
