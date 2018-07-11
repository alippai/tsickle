/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as path from 'path';

import * as jsdoc from './jsdoc';
import {AnnotatorHost, escapeForComment, isValidClosurePropertyName, maybeAddHeritageClauses} from './jsdoc_transformer';
import {ModuleTypeTranslator} from './module_type_translator';
import {getEntityNameText, getIdentifierText} from './rewriter';
import * as ts from './typescript';
import {hasModifierFlag, isDtsFileName} from './util';

/**
 * Symbols that are already declared as externs in Closure, that should
 * be avoided by tsickle's "declare ..." => externs.js conversion.
 */
const CLOSURE_EXTERNS_BLACKLIST: ReadonlyArray<string> = [
  'exports',
  'global',
  'module',
  // ErrorConstructor is the interface of the Error object itself.
  // tsickle detects that this is part of the TypeScript standard library
  // and assumes it's part of the Closure standard library, but this
  // assumption is wrong for ErrorConstructor.  To properly handle this
  // we'd somehow need to map methods defined on the ErrorConstructor
  // interface into properties on Closure's Error object, but for now it's
  // simpler to just blacklist it.
  'ErrorConstructor',
  'Symbol',
  'WorkerGlobalScope',
];

export function createExterns(
    typeChecker: ts.TypeChecker, sourceFile: ts.SourceFile,
    host: AnnotatorHost): {output: string, diagnostics: ts.Diagnostic[]} {
  let output = '';
  const diagnostics: ts.Diagnostic[] = [];
  const isDts = isDtsFileName(sourceFile.fileName);
  const mtt =
      new ModuleTypeTranslator(sourceFile, typeChecker, host, diagnostics, /*isForExterns*/ true);

  for (const stmt of sourceFile.statements) {
    if (!isDts && !hasModifierFlag(stmt, ts.ModifierFlags.Ambient)) continue;
    visitor(stmt, []);
  }

  return {output, diagnostics};

  function emit(str: string) {
    output += str;
  }

  /**
   * isFirstDeclaration returns true if decl is the first declaration
   * of its symbol.  E.g. imagine
   *   interface Foo { x: number; }
   *   interface Foo { y: number; }
   * we only want to emit the "\@record" for Foo on the first one.
   */
  function isFirstDeclaration(decl: ts.DeclarationStatement): boolean {
    if (!decl.name) return true;
    const sym = typeChecker.getSymbolAtLocation(decl.name)!;
    if (!sym.declarations || sym.declarations.length < 2) return true;
    return decl === sym.declarations[0];
  }

  function writeExternsVariable(name: string, namespace: ReadonlyArray<string>, value?: string) {
    const qualifiedName = namespace.concat([name]).join('.');
    if (namespace.length === 0) emit(`var `);
    emit(qualifiedName);
    if (value) emit(` = ${value}`);
    emit(';\n');
  }

  function writeExternsVariableDecl(
      decl: ts.VariableDeclaration, namespace: ReadonlyArray<string>) {
    if (decl.name.kind === ts.SyntaxKind.Identifier) {
      const name = getIdentifierText(decl.name as ts.Identifier);
      if (CLOSURE_EXTERNS_BLACKLIST.indexOf(name) >= 0) return;
      emitJSDocType(decl);
      emit('\n');
      writeExternsVariable(name, namespace);
    } else {
      errorUnimplementedKind(decl.name, 'externs for variable');
    }
  }

  /**
   * Emits a type annotation in JSDoc, or {?} if the type is unavailable.
   * @param skipBlacklisted if true, do not emit a type at all for blacklisted types.
   */
  function emitJSDocType(
      node: ts.Node, additionalDocTag?: string, type?: ts.Type, skipBlacklisted = false) {
    if (skipBlacklisted) {
      // Check if the type is blacklisted, and do not emit any @type at all if so.
      type = type || typeChecker.getTypeAtLocation(node);
      let sym = type.symbol;
      if (sym) {
        if (sym.flags & ts.SymbolFlags.Alias) {
          sym = typeChecker.getAliasedSymbol(sym);
        }
        const typeTranslator = mtt.newTypeTranslator(node);
        if (typeTranslator.isBlackListed(sym)) {
          if (additionalDocTag) emit(` /** ${additionalDocTag} */`);
          return;
        }
      }
    }
    emit(' /**');
    if (additionalDocTag) {
      emit(' ' + additionalDocTag);
    }
    emit(` @type {${mtt.typeToClosure(node, type)}} */`);
  }

  /**
   * Emits a JSDoc declaration that merges the signatures of the given function declaration (for
   * overloads), and returns the parameter names chosen.
   */
  function emitFunctionType(decls: ts.FunctionLikeDeclaration[], extraTags: jsdoc.Tag[] = []) {
    const [tags, paramNames] = mtt.getFunctionTypeJSDoc(decls);
    emit('\n');
    emit(jsdoc.toString(extraTags.concat(tags)));
    return paramNames;
  }

  function writeExternsFunction(name: ts.Node, params: string[], namespace: ReadonlyArray<string>) {
    const paramsStr = params.join(', ');
    if (namespace.length > 0) {
      let fqn = namespace.join('.');
      if (name.kind === ts.SyntaxKind.Identifier) {
        fqn += '.';  // computed names include [ ] in their getText() representation.
      }
      fqn += name.getText();
      emit(`${fqn} = function(${paramsStr}) {};\n`);
    } else {
      if (name.kind !== ts.SyntaxKind.Identifier) {
        error(name, 'Non-namespaced computed name in externs');
      }
      emit(`function ${name.getText()}(${paramsStr}) {}\n`);
    }
  }

  function writeExternsEnum(decl: ts.EnumDeclaration, namespace: ReadonlyArray<string>) {
    const name = getIdentifierText(decl.name);
    emit('\n/** @const */\n');
    writeExternsVariable(name, namespace, '{}');
    namespace = namespace.concat([name]);
    for (const member of decl.members) {
      let memberName: string|undefined;
      switch (member.name.kind) {
        case ts.SyntaxKind.Identifier:
          memberName = getIdentifierText(member.name as ts.Identifier);
          break;
        case ts.SyntaxKind.StringLiteral:
          const text = (member.name as ts.StringLiteral).text;
          if (isValidClosurePropertyName(text)) memberName = text;
          break;
        default:
          break;
      }
      if (!memberName) {
        emit(`\n/* TODO: ${ts.SyntaxKind[member.name.kind]}: ${
            escapeForComment(member.name.getText())} */\n`);
        continue;
      }
      emit('/** @const {number} */\n');
      writeExternsVariable(memberName, namespace);
    }
  }

  function writeExternsTypeAlias(decl: ts.TypeAliasDeclaration, namespace: ReadonlyArray<string>) {
    const typeStr = mtt.typeToClosure(decl, undefined);
    emit(`\n/** @typedef {${typeStr}} */\n`);
    writeExternsVariable(getIdentifierText(decl.name), namespace);
  }

  function writeExternsType(
      decl: ts.InterfaceDeclaration|ts.ClassDeclaration, namespace: ReadonlyArray<string>) {
    const name = decl.name;
    if (!name) {
      error(decl, 'anonymous type in externs');
      return;
    }
    const typeName = namespace.concat([name.getText()]).join('.');
    if (CLOSURE_EXTERNS_BLACKLIST.indexOf(typeName) >= 0) return;

    if (isFirstDeclaration(decl)) {
      let paramNames: string[] = [];
      const jsdocTags: jsdoc.Tag[] = [];
      let writeJsDoc = true;
      maybeAddHeritageClauses(jsdocTags, mtt, decl);
      if (decl.kind === ts.SyntaxKind.ClassDeclaration) {
        jsdocTags.push({tagName: 'constructor'});
        jsdocTags.push({tagName: 'struct'});
        const ctors = (decl as ts.ClassDeclaration)
                          .members.filter((m) => m.kind === ts.SyntaxKind.Constructor);
        if (ctors.length) {
          writeJsDoc = false;
          const firstCtor: ts.ConstructorDeclaration = ctors[0] as ts.ConstructorDeclaration;
          const ctorTags = [{tagName: 'constructor'}, {tagName: 'struct'}];
          if (ctors.length > 1) {
            paramNames = emitFunctionType(ctors as ts.ConstructorDeclaration[], ctorTags);
          } else {
            paramNames = emitFunctionType([firstCtor], ctorTags);
          }
        }
      } else {
        jsdocTags.push({tagName: 'record'});
        jsdocTags.push({tagName: 'struct'});
      }
      if (writeJsDoc) emit(jsdoc.toString(jsdocTags));
      writeExternsFunction(name, paramNames, namespace);
    }

    // Process everything except (MethodSignature|MethodDeclaration|Constructor)
    const methods = new Map<string, ts.MethodDeclaration[]>();
    for (const member of decl.members) {
      switch (member.kind) {
        case ts.SyntaxKind.PropertySignature:
        case ts.SyntaxKind.PropertyDeclaration:
          const prop = member as ts.PropertySignature;
          if (prop.name.kind === ts.SyntaxKind.Identifier) {
            emitJSDocType(prop);
            if (hasModifierFlag(prop, ts.ModifierFlags.Static)) {
              emit(`\n${typeName}.${prop.name.getText()};\n`);
            } else {
              emit(`\n${typeName}.prototype.${prop.name.getText()};\n`);
            }
            continue;
          }
          // TODO: For now property names other than Identifiers are not handled; e.g.
          //    interface Foo { "123bar": number }
          break;
        case ts.SyntaxKind.MethodSignature:
        case ts.SyntaxKind.MethodDeclaration:
          const method = member as ts.MethodDeclaration;
          const isStatic = hasModifierFlag(method, ts.ModifierFlags.Static);
          const methodSignature = `${method.name.getText()}$$$${isStatic ? 'static' : 'instance'}`;

          if (methods.has(methodSignature)) {
            methods.get(methodSignature)!.push(method);
          } else {
            methods.set(methodSignature, [method]);
          }
          continue;
        case ts.SyntaxKind.Constructor:
          continue;  // Handled above.
        default:
          // Members can include things like index signatures, for e.g.
          //   interface Foo { [key: string]: number; }
          // For now, just skip it.
          break;
      }
      // If we get here, the member wasn't handled in the switch statement.
      let memberName = namespace;
      if (member.name) {
        memberName = memberName.concat([member.name.getText()]);
      }
      emit(`\n/* TODO: ${ts.SyntaxKind[member.kind]}: ${memberName.join('.')} */\n`);
    }

    // Handle method declarations/signatures separately, since we need to deal with overloads.
    for (const methodVariants of Array.from(methods.values())) {
      const firstMethodVariant = methodVariants[0];
      let parameterNames: string[];
      if (methodVariants.length > 1) {
        parameterNames = emitFunctionType(methodVariants);
      } else {
        parameterNames = emitFunctionType([firstMethodVariant]);
      }
      const methodNamespace = namespace.concat([name.getText()]);
      // If the method is static, don't add the prototype.
      if (!hasModifierFlag(firstMethodVariant, ts.ModifierFlags.Static)) {
        methodNamespace.push('prototype');
      }
      writeExternsFunction(firstMethodVariant.name, parameterNames, methodNamespace);
    }
  }

  function error(node: ts.Node, messageText: string) {
    diagnostics.push({
      file: node.getSourceFile(),
      start: node.getStart(),
      length: node.getEnd() - node.getStart(),
      messageText,
      category: ts.DiagnosticCategory.Error,
      code: 0,
    });
  }

  /**
   * Produces a compiler error that references the Node's kind. This is useful for the "else"
   * branch of code that is attempting to handle all possible input Node types, to ensure all cases
   * covered.
   */
  function errorUnimplementedKind(node: ts.Node, where: string) {
    error(node, `${ts.SyntaxKind[node.kind]} not implemented in ${where}`);
  }

  function visitor(node: ts.Node, namespace: ReadonlyArray<string>) {
    switch (node.kind) {
      case ts.SyntaxKind.ModuleDeclaration:
        const decl = node as ts.ModuleDeclaration;
        switch (decl.name.kind) {
          case ts.SyntaxKind.Identifier:
            // E.g. "declare namespace foo {"
            const name = getIdentifierText(decl.name as ts.Identifier);
            if (name === 'global') {
              // E.g. "declare global { ... }".  Reset to the outer namespace.
              namespace = [];
            } else {
              if (isFirstDeclaration(decl)) {
                emit('/** @const */\n');
                writeExternsVariable(name, namespace, '{}');
              }
              namespace = namespace.concat(name);
            }
            if (decl.body) visitor(decl.body, namespace);
            break;
          case ts.SyntaxKind.StringLiteral:
            // E.g. "declare module 'foo' {" (note the quotes).
            // We still want to emit externs for this module, but
            // Closure doesn't really provide a mechanism for
            // module-scoped externs.  For now, ignore the enclosing
            // namespace (because this is declaring a top-level module)
            // and emit into a fake namespace.

            // Declare the top-level "tsickle_declare_module".
            emit('/** @const */\n');
            writeExternsVariable('tsickle_declare_module', [], '{}');
            namespace = ['tsickle_declare_module'];

            // Declare the inner "tsickle_declare_module.foo", if it's not
            // declared already elsewhere.
            let importName = (decl.name as ts.StringLiteral).text;
            emit(`// Derived from: declare module "${importName}"\n`);
            // We also don't care about the actual name of the module ("foo"
            // in the above example), except that we want it to not conflict.
            importName = importName.replace(/_/, '__').replace(/[^A-Za-z]/g, '_');
            if (isFirstDeclaration(decl)) {
              emit('/** @const */\n');
              writeExternsVariable(importName, namespace, '{}');
            }

            // Declare the contents inside the "tsickle_declare_module.foo".
            if (decl.body) visitor(decl.body, namespace.concat(importName));
            break;
          default:
            errorUnimplementedKind(decl.name, 'externs generation of namespace');
            break;
        }
        break;
      case ts.SyntaxKind.ModuleBlock:
        const block = node as ts.ModuleBlock;
        for (const stmt of block.statements) {
          visitor(stmt, namespace);
        }
        break;
      case ts.SyntaxKind.ImportEqualsDeclaration:
        const importEquals = node as ts.ImportEqualsDeclaration;
        const localName = getIdentifierText(importEquals.name);
        if (localName === 'ng') {
          emit(`\n/* Skipping problematic import ng = ...; */\n`);
          break;
        }
        if (importEquals.moduleReference.kind === ts.SyntaxKind.ExternalModuleReference) {
          emit(`\n/* TODO: import ${localName} = require(...) */\n`);
          break;
        }
        const qn = getEntityNameText(importEquals.moduleReference);
        // @const so that Closure Compiler understands this is an alias.
        if (namespace.length === 0) emit('/** @const */\n');
        writeExternsVariable(localName, namespace, qn);
        break;
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.InterfaceDeclaration:
        writeExternsType(node as ts.InterfaceDeclaration | ts.ClassDeclaration, namespace);
        break;
      case ts.SyntaxKind.FunctionDeclaration:
        const fnDecl = node as ts.FunctionDeclaration;
        const name = fnDecl.name;
        if (!name) {
          error(fnDecl, 'anonymous function in externs');
          break;
        }
        // Gather up all overloads of this function.
        const sym = typeChecker.getSymbolAtLocation(name)!;
        const decls = sym.declarations!.filter(d => d.kind === ts.SyntaxKind.FunctionDeclaration) as
            ts.FunctionDeclaration[];
        // Only emit the first declaration of each overloaded function.
        if (fnDecl !== decls[0]) break;
        const params = emitFunctionType(decls);
        writeExternsFunction(name, params, namespace);
        break;
      case ts.SyntaxKind.VariableStatement:
        for (const decl of (node as ts.VariableStatement).declarationList.declarations) {
          writeExternsVariableDecl(decl, namespace);
        }
        break;
      case ts.SyntaxKind.EnumDeclaration:
        writeExternsEnum(node as ts.EnumDeclaration, namespace);
        break;
      case ts.SyntaxKind.TypeAliasDeclaration:
        writeExternsTypeAlias(node as ts.TypeAliasDeclaration, namespace);
        break;
      default:
        const locationStr = namespace.join('.') || path.basename(node.getSourceFile().fileName);
        emit(`\n// TODO(tsickle): ${ts.SyntaxKind[node.kind]} in ${locationStr}\n`);
        break;
    }
  }
}
