goog.module('test_files.coerce.coerce');var module = {id: 'test_files/coerce/coerce.js'};/**
 * @param {string} arg
 * @return {string}
 */
function acceptString(arg) { return arg; }
acceptString(/** @type {?} */ (3));