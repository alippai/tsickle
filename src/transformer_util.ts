/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AnnotatorHost} from './jsdoc_transformer';
import * as ts from './typescript';
import {hasModifierFlag} from './util';

/**
 * ts.createNotEmittedStatement will create a node whose comments are never emitted except for very
 * specific special cases (/// comments). createNotEmittedStatementWithComments creates a not
 * emitted statement and adds comment ranges from the original statement as synthetic comments to
 * it, so that they get retained in the output.
 */
export function createNotEmittedStatementWithComments(
    sourceFile: ts.SourceFile, original: ts.Node): ts.Statement {
  let replacement = ts.createNotEmittedStatement(original);
  // NB: synthetic nodes can have pos/end == -1. This is handled by the underlying implementation.
  const leading = ts.getLeadingCommentRanges(sourceFile.text, original.pos) || [];
  const trailing = ts.getTrailingCommentRanges(sourceFile.text, original.end) || [];
  replacement =
      ts.setSyntheticLeadingComments(replacement, synthesizeCommentRanges(sourceFile, leading));
  replacement =
      ts.setSyntheticTrailingComments(replacement, synthesizeCommentRanges(sourceFile, trailing));
  return replacement;
}

/**
 * Converts `ts.CommentRange`s into `ts.SynthesizedComment`s
 */
export function synthesizeCommentRanges(
    sourceFile: ts.SourceFile, parsedComments: ts.CommentRange[]): ts.SynthesizedComment[] {
  const synthesizedComments: ts.SynthesizedComment[] = [];
  parsedComments.forEach(({kind, pos, end, hasTrailingNewLine}, commentIdx) => {
    let commentText = sourceFile.text.substring(pos, end).trim();
    if (kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      commentText = commentText.replace(/(^\/\*)|(\*\/$)/g, '');
    } else if (kind === ts.SyntaxKind.SingleLineCommentTrivia) {
      if (commentText.startsWith('///')) {
        // triple-slash comments are typescript specific, ignore them in the output.
        return;
      }
      commentText = commentText.replace(/(^\/\/)/g, '');
    }
    synthesizedComments.push({kind, text: commentText, hasTrailingNewLine, pos: -1, end: -1});
  });
  return synthesizedComments;
}

/**
 * Creates a non emitted statement that can be used to store synthesized comments.
 */
export function createNotEmittedStatement(sourceFile: ts.SourceFile): ts.NotEmittedStatement {
  const stmt = ts.createNotEmittedStatement(sourceFile);
  ts.setOriginalNode(stmt, undefined);
  ts.setTextRange(stmt, {pos: 0, end: 0});
  ts.setEmitFlags(stmt, ts.EmitFlags.CustomPrologue);
  return stmt;
}

/**
 * Returns the leading comment ranges in the source file that start at the given position.
 * This is the same as `ts.getLeadingCommentRanges`, except that it does not skip
 * comments before the first newline in the range.
 *
 * @param sourceFile
 * @param start Where to start scanning
 * @param end Where to end scanning
 */
export function getAllLeadingCommentRanges(
    sourceFile: ts.SourceFile, start: number, end: number): ts.CommentRange[] {
  // exeute ts.getLeadingCommentRanges with pos = 0 so that it does not skip
  // comments until the first newline.
  const commentRanges = ts.getLeadingCommentRanges(sourceFile.text.substring(start, end), 0) || [];
  return commentRanges.map(cr => ({
                             hasTrailingNewLine: cr.hasTrailingNewLine,
                             kind: cr.kind as number,
                             pos: cr.pos + start,
                             end: cr.end + start
                           }));
}

/**
 * This is a version of `ts.visitEachChild` that works that calls our version
 * of `updateSourceFileNode`, so that typescript doesn't lose type information
 * for property decorators.
 * See https://github.com/Microsoft/TypeScript/issues/17384
 *
 * @param sf
 * @param statements
 */
export function visitEachChild(
    node: ts.Node, visitor: ts.Visitor, context: ts.TransformationContext): ts.Node {
  if (node.kind === ts.SyntaxKind.SourceFile) {
    const sf = node as ts.SourceFile;
    return updateSourceFileNode(sf, ts.visitLexicalEnvironment(sf.statements, visitor, context));
  }

  return ts.visitEachChild(node, visitor, context);
}

/**
 * This is a version of `ts.updateSourceFileNode` that works
 * well with property decorators.
 * See https://github.com/Microsoft/TypeScript/issues/17384
 * TODO(#634): This has been fixed in TS 2.5. Investigate removal.
 *
 * @param sf
 * @param statements
 */
export function updateSourceFileNode(
    sf: ts.SourceFile, statements: ts.NodeArray<ts.Statement>): ts.SourceFile {
  if (statements === sf.statements) {
    return sf;
  }
  // Note: Need to clone the original file (and not use `ts.updateSourceFileNode`)
  // as otherwise TS fails when resolving types for decorators.
  sf = ts.getMutableClone(sf);
  sf.statements = statements;
  return sf;
}

// Copied from TypeScript
export function isTypeNodeKind(kind: ts.SyntaxKind) {
  return (kind >= ts.SyntaxKind.FirstTypeNode && kind <= ts.SyntaxKind.LastTypeNode) ||
      kind === ts.SyntaxKind.AnyKeyword || kind === ts.SyntaxKind.NumberKeyword ||
      kind === ts.SyntaxKind.ObjectKeyword || kind === ts.SyntaxKind.BooleanKeyword ||
      kind === ts.SyntaxKind.StringKeyword || kind === ts.SyntaxKind.SymbolKeyword ||
      kind === ts.SyntaxKind.ThisKeyword || kind === ts.SyntaxKind.VoidKeyword ||
      kind === ts.SyntaxKind.UndefinedKeyword || kind === ts.SyntaxKind.NullKeyword ||
      kind === ts.SyntaxKind.NeverKeyword || kind === ts.SyntaxKind.ExpressionWithTypeArguments;
}

/**
 * Creates a string literal that uses single quotes. Purely cosmetic, but increases fidelity to the
 * existing test suite.
 */
export function createSingleQuoteStringLiteral(text: string): ts.StringLiteral {
  const stringLiteral = ts.createLiteral(text);
  // tslint:disable-next-line:no-any accessing TS internal API.
  (stringLiteral as any).singleQuote = true;
  return stringLiteral;
}

/** Creates a not emitted statement with the given text as a single line comment. */
export function createSingleLineComment(original: ts.Node, text: string) {
  const comment: ts.SynthesizedComment = {
    kind: ts.SyntaxKind.SingleLineCommentTrivia,
    text: ' ' + text,
    hasTrailingNewLine: true,
    pos: -1,
    end: -1,
  };
  return ts.setSyntheticTrailingComments(ts.createNotEmittedStatement(original), [comment]);
}

/** Creates a not emitted statement with the given text as a single line comment. */
export function createMultiLineComment(original: ts.Node, text: string) {
  const notEmitted = ts.createNotEmittedStatement(original);
  const comment: ts.SynthesizedComment = {
    kind: ts.SyntaxKind.MultiLineCommentTrivia,
    text: ' ' + text,
    hasTrailingNewLine: true,
    pos: -1,
    end: -1,
  };
  return ts.setSyntheticTrailingComments(ts.createNotEmittedStatement(original), [comment]);
}

/**
 * debugWarn logs a debug warning.
 *
 * These should only be used for cases where tsickle is making a questionable judgement about what
 * to do. By default, tsickle does not report any warnings to the caller, and warnings are hidden
 * behind a debug flag, as warnings are only for tsickle to debug itself.
 */
export function debugWarn(host: AnnotatorHost, context: ts.Node, messageText: string) {
  if (!host.logWarning) return;
  // Use a ts.Diagnosic so that the warning includes context and file offets.
  const diagnostic: ts.Diagnostic = {
    file: context.getSourceFile(),
    start: context.getStart(),
    length: context.getEnd() - context.getStart(),
    messageText,
    category: ts.DiagnosticCategory.Warning,
    code: 0,
  };
  host.logWarning(diagnostic);
}

/**
 * A replacement for ts.getLeadingCommentRanges that returns the union of synthetic and
 * non-synthetic comments on the given node, with their text included. The returned comments must
 * not be mutated, as their content might or might not be reflected back into the AST.
 */
export function getAllLeadingComments(node: ts.Node):
    ReadonlyArray<Readonly<ts.CommentRange&{text: string}>> {
  const allRanges: Array<Readonly<ts.CommentRange&{text: string}>> = [];
  const nodeText = node.getFullText();
  const cr = ts.getLeadingCommentRanges(nodeText, 0);
  if (cr) allRanges.push(...cr.map(c => ({...c, text: nodeText.substring(c.pos, c.end)})));
  const synthetic = ts.getSyntheticLeadingComments(node);
  if (synthetic) allRanges.push(...synthetic);
  return allRanges;
}
