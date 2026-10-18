// Prints part of a log as an error annotation: annotations can be read without signing in to
// GitHub, logs cannot. Usage: node .github/annotate.cjs <log file> <title>
const fs = require('fs');

const [file, title] = process.argv.slice(2);
const log = fs.readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
// Cargo prints what failing tests said under "failures:"; anything else, the end says most.
const failures = log.indexOf('\nfailures:\n');
const part = failures >= 0 ? log.slice(failures + 1, failures + 6001) : log.slice(-6000);
console.log(`::error title=${title}::` + part.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
