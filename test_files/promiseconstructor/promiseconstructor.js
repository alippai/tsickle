/**
 * @fileoverview added by tsickle
 * @suppress {checkTypes,extraRequire,uselessCode} checked by tsc
 */
goog.module('test_files.promiseconstructor.promiseconstructor');
var module = module || { id: 'test_files/promiseconstructor/promiseconstructor.ts' };
// typeof Promise actually resolves to "PromiseConstructor" in TypeScript, which
// is a type that doesn't exist in Closure's type world. This code passes the
// e2e test because closure_externs.js declares PromiseConstructor.
/**
 * @param {(undefined|!PromiseConstructor)=} promiseCtor
 * @return {!Promise<void>}
 */
function f(promiseCtor) {
    return promiseCtor ? new promiseCtor((res, rej) => res()) : Promise.resolve();
}
