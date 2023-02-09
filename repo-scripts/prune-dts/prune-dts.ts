/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as yargs from 'yargs';
import * as ts from 'typescript';
import * as fs from 'fs';
import { ESLint } from 'eslint';

/**
 * Prunes a DTS file based on three main rules:
 * - Top level types are only included if they are also exported.
 * - Underscore-prefixed members of class and interface types are stripped.
 * - Constructors are made private or protected if marked with
 *   `@hideconstructor`/`@hideconstructor protected`.
 *
 * This function is meant to operate on DTS files generated by API extractor
 * and extracts out the API that is relevant for third-party SDK consumers.
 *
 * @param inputLocation The file path to the .d.ts produced by API explorer.
 * @param outputLocation The output location for the pruned .d.ts file.
 */
export function pruneDts(inputLocation: string, outputLocation: string): void {
  const compilerOptions = {};
  const host = ts.createCompilerHost(compilerOptions);
  const program = ts.createProgram([inputLocation], compilerOptions, host);
  const printer: ts.Printer = ts.createPrinter();
  const sourceFile = program.getSourceFile(inputLocation)!;

  const result: ts.TransformationResult<ts.SourceFile> =
    ts.transform<ts.SourceFile>(sourceFile, [
      dropPrivateApiTransformer.bind(null, program, host)
    ]);
  const transformedSourceFile: ts.SourceFile = result.transformed[0];
  let content = printer.printFile(transformedSourceFile);

  fs.writeFileSync(outputLocation, content);
}

export async function addBlankLines(outputLocation: string): Promise<void> {
  const eslint = new ESLint({
    fix: true,
    overrideConfig: {
      parserOptions: {
        ecmaVersion: 2017,
        sourceType: 'module',
        tsconfigRootDir: __dirname,
        project: ['./tsconfig.eslint.json']
      },
      env: {
        es6: true
      },
      plugins: ['@typescript-eslint'],
      parser: '@typescript-eslint/parser',
      rules: {
        'unused-imports/no-unused-imports-ts': ['off'],
        // add blank lines after imports. Otherwise removeUnusedImports() will remove the comment
        // of the first item after the import block
        'padding-line-between-statements': [
          'error',
          { 'blankLine': 'always', 'prev': 'import', 'next': '*' }
        ]
      }
    }
  });
  const results = await eslint.lintFiles(outputLocation);
  await ESLint.outputFixes(results);
}

export async function removeUnusedImports(
  outputLocation: string
): Promise<void> {
  const eslint = new ESLint({
    fix: true,
    overrideConfig: {
      parserOptions: {
        ecmaVersion: 2017,
        sourceType: 'module',
        tsconfigRootDir: __dirname,
        project: ['./tsconfig.eslint.json']
      },
      env: {
        es6: true
      },
      plugins: ['unused-imports', '@typescript-eslint'],
      parser: '@typescript-eslint/parser',
      rules: {
        'unused-imports/no-unused-imports-ts': ['error']
      }
    }
  });
  const results = await eslint.lintFiles(outputLocation);
  await ESLint.outputFixes(results);
}

/** Determines whether the provided identifier should be hidden. */
function hasPrivatePrefix(name: ts.Identifier): boolean {
  // Identifiers that are prefixed with an underscore are not not included in
  // the public API.
  return !!name.escapedText?.toString().startsWith('_');
}

/** Returns whether type identified by `name` is exported. */
function isExported(
  typeChecker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  name: ts.Identifier
): boolean {
  const declarations =
    typeChecker.getSymbolAtLocation(name)?.declarations ?? [];

  // Check is this is a public symbol (e.g. part of the DOM library)
  const isTypescriptType = declarations.find(
    d => d.getSourceFile().fileName.indexOf('typescript/lib') != -1
  );
  const isImported = declarations.find(d => ts.isImportSpecifier(d));
  if (isTypescriptType || isImported) {
    return true;
  }

  // Check is this is part of the exported symbols of the SDK module
  const allExportedSymbols = typeChecker.getExportsOfModule(
    typeChecker.getSymbolAtLocation(sourceFile)!
  );
  return !!allExportedSymbols.find(s => s.name === name.escapedText);
}

/**
 * Replaces an existing constructor implementation if the constructor is marked
 * with the JSDod tag `@hideconstructor`. The replaced constructor can either
 * have `private` visibility` or `proctected`. To generate a protected
 * constructor, specify `@hideconstructor proctected`.
 *
 * Returns either the modified constructor or the existing constructor if no
 * modification was needed.
 */
function maybeHideConstructor(
  node: ts.ConstructorDeclaration
): ts.ConstructorDeclaration {
  const hideConstructorTag = ts
    .getJSDocTags(node)
    ?.find(t => t.tagName.escapedText === 'hideconstructor');

  if (hideConstructorTag) {
    const modifier = ts.createModifier(
      hideConstructorTag.comment === 'protected'
        ? ts.SyntaxKind.ProtectedKeyword
        : ts.SyntaxKind.PrivateKeyword
    );
    return ts.createConstructor(
      node.decorators,
      [modifier],
      /*parameters=*/ [],
      /* body= */ undefined
    );
  } else {
    return node;
  }
}

/**
 * Examines `extends` and `implements` clauses and removes or replaces them if
 * they refer to a non-exported type. When an export is removed, all members
 * from the removed class are merged into the provided class or interface
 * declaration.
 *
 * @example
 * Input:
 * class Foo {
 *   foo: string;
 * }
 * export class Bar extends Foo {}
 *
 * Output:
 * export class Bar {
 *   foo: string;
 * }
 */
function prunePrivateImports<
  T extends ts.InterfaceDeclaration | ts.ClassDeclaration
>(
  factory: ts.NodeFactory,
  program: ts.Program,
  host: ts.CompilerHost,
  sourceFile: ts.SourceFile,
  node: T
): T {
  const typeChecker = program.getTypeChecker();

  // The list of heritage clauses after all private symbols are removed.
  const prunedHeritageClauses: ts.HeritageClause[] = [];
  // Additional members that are copied from the private symbols into the public
  // symbols
  const additionalMembers: ts.Node[] = [];

  for (const heritageClause of node.heritageClauses || []) {
    const exportedTypes: ts.ExpressionWithTypeArguments[] = [];
    for (const type of heritageClause.types) {
      if (
        ts.isIdentifier(type.expression) &&
        isExported(typeChecker, sourceFile, type.expression)
      ) {
        exportedTypes.push(type);
      } else {
        // Hide the type we are inheriting from and merge its declarations
        // into the current class.
        // TODO: We really only need to do this when the type that is extended
        // is a class. We should skip this for interfaces.
        const privateType = typeChecker.getTypeAtLocation(type);
        additionalMembers.push(
          ...convertPropertiesForEnclosingClass(
            program,
            host,
            sourceFile,
            privateType.getProperties(),
            node
          )
        );
      }
    }

    if (exportedTypes.length > 0) {
      prunedHeritageClauses.push(
        factory.updateHeritageClause(heritageClause, exportedTypes)
      );
    }
  }

  if (ts.isClassDeclaration(node)) {
    return factory.updateClassDeclaration(
      node,
      node.decorators,
      node.modifiers,
      node.name,
      node.typeParameters,
      prunedHeritageClauses,
      [
        ...(node.members as ts.NodeArray<ts.ClassElement>),
        ...(additionalMembers as ts.ClassElement[])
      ]
    ) as T;
  } else if (ts.isInterfaceDeclaration(node)) {
    return factory.updateInterfaceDeclaration(
      node,
      node.decorators,
      node.modifiers,
      node.name,
      node.typeParameters,
      prunedHeritageClauses,
      [
        ...(node.members as ts.NodeArray<ts.TypeElement>),
        ...(additionalMembers as ts.TypeElement[])
      ]
    ) as T;
  } else {
    throw new Error('Only classes or interfaces are supported');
  }
}

/**
 * Iterates the provided symbols and returns named declarations for these
 * symbols if they are missing from `currentClass`. This allows us to merge
 * class hierarchies for classes whose inherited types are not part of the
 * public API.
 *
 * This method relies on a private API in TypeScript's `codefix` package.
 */
function convertPropertiesForEnclosingClass(
  program: ts.Program,
  host: ts.CompilerHost,
  sourceFile: ts.SourceFile,
  parentClassSymbols: ts.Symbol[],
  currentClass: ts.ClassDeclaration | ts.InterfaceDeclaration
): ts.Node[] {
  const newMembers: ts.Node[] = [];
  // The `codefix` package is not public but it does exactly what we want. It's
  // the same package that is used by VSCode to fill in missing members, which
  // is what we are using it for in this script. `codefix` handles missing
  // properties, methods and correctly deduces generics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ts as any).codefix.createMissingMemberNodes(
    currentClass,
    parentClassSymbols,
    sourceFile,
    { program, host },
    /* userPreferences= */ {},
    /* importAdder= */ undefined,
    (missingMember: ts.ClassElement) => {
      const originalSymbol = parentClassSymbols.find(
        symbol =>
          symbol.escapedName ==
          (missingMember.name as ts.Identifier).escapedText
      );
      const jsDocComment = originalSymbol
        ? extractJSDocComment(originalSymbol, newMembers)
        : undefined;
      if (jsDocComment) {
        newMembers.push(jsDocComment, missingMember);
      } else {
        newMembers.push(missingMember);
      }
    }
  );
  return newMembers;
}

/** Extracts the JSDoc comment from `symbol`. */
function extractJSDocComment(
  symbol: ts.Symbol,
  alreadyAddedMembers: ts.Node[]
): ts.Node | null {
  const overloadCount = alreadyAddedMembers.filter(
    node =>
      ts.isClassElement(node) &&
      (node.name as ts.Identifier).escapedText == symbol.name
  ).length;

  // Extract the comment from the overload that we are currently processing.
  let targetIndex = 0;
  const comments = symbol.getDocumentationComment(undefined).filter(symbol => {
    // Overload comments are separated by line breaks.
    if (symbol.kind == 'lineBreak') {
      ++targetIndex;
      return false;
    } else {
      return overloadCount == targetIndex;
    }
  });

  if (comments.length > 0 && symbol.declarations) {
    const jsDocTags = ts.getJSDocTags(symbol.declarations[overloadCount]);
    const maybeNewline = jsDocTags?.length > 0 ? '\n' : '';
    const joinedComments = comments
      .map(comment => {
        if (comment.kind === 'linkText') {
          return comment.text.trim();
        }
        return comment.text;
      })
      .join('');
    const formattedComments = joinedComments
      .replace('*', '\n')
      .replace(' \n', '\n')
      .replace('\n ', '\n');
    return ts.factory.createJSDocComment(
      formattedComments + maybeNewline,
      jsDocTags
    );
  }
  return null;
}

/**
 * Replaces input types of public APIs that consume non-exported types, which
 * allows us to exclude private types from the pruned definitions. Returns the
 * the name of the exported API or undefined if no type is found.
 *
 * @example
 * Input:
 * class PrivateFoo {}
 * export class PublicFoo extends PrivateFoo {}
 * export function doFoo(foo: PrivateFoo);
 *
 * Output:
 * export class PublicFoo {}
 * export function doFoo(foo: PublicFoo);
 */
function extractExportedSymbol(
  typeChecker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  typeName: ts.Node
): ts.Symbol | undefined {
  if (!ts.isIdentifier(typeName)) {
    return undefined;
  }

  if (isExported(typeChecker, sourceFile, typeName)) {
    // Don't replace the type reference if the type is already part of the
    // public API.
    return undefined;
  }

  const localSymbolName = typeName.escapedText;
  const allExportedSymbols = typeChecker.getExportsOfModule(
    typeChecker.getSymbolAtLocation(sourceFile)!
  );

  // Examine all exported types and check if they extend or implement the
  // provided local type. If so, we can use the exported type in lieu of the
  // private type.

  // Short circuit if the local types is already part of the public types.
  for (const symbol of allExportedSymbols) {
    if (symbol.name === localSymbolName) {
      return symbol;
    }
  }

  // See if there is an exported symbol that extends this private symbol.
  // In this case, we can safely use the public symbol instead.
  for (const symbol of allExportedSymbols) {
    if (symbol.declarations) {
      for (const declaration of symbol.declarations) {
        if (
          ts.isClassDeclaration(declaration) ||
          ts.isInterfaceDeclaration(declaration)
        ) {
          for (const heritageClause of declaration.heritageClauses || []) {
            for (const type of heritageClause.types || []) {
              if (ts.isIdentifier(type.expression)) {
                const subclassName = type.expression.escapedText;
                if (subclassName === localSymbolName) {
                  // TODO: We may need to change this to return a Union type if
                  // more than one public type corresponds to the private type.
                  return symbol;
                }
              }
            }
          }
        }
      }
    }
  }

  // If no symbol was found that extends the private symbol, check the reverse.
  // We might find an exported symbol in the inheritance chain of the local
  // symbol. Note that this is not always safe as we might replace the local
  // symbol with a less restrictive type.
  const localSymbol = typeChecker.getSymbolAtLocation(typeName);
  if (localSymbol?.declarations) {
    for (const declaration of localSymbol.declarations) {
      if (
        ts.isClassDeclaration(declaration) ||
        ts.isInterfaceDeclaration(declaration)
      ) {
        for (const heritageClause of declaration.heritageClauses || []) {
          for (const type of heritageClause.types || []) {
            if (ts.isIdentifier(type.expression)) {
              if (isExported(typeChecker, sourceFile, type.expression)) {
                return typeChecker.getSymbolAtLocation(type.expression);
              }
            }
          }
        }
      }
    }
  }

  return undefined;
}

function dropPrivateApiTransformer(
  program: ts.Program,
  host: ts.CompilerHost,
  context: ts.TransformationContext
): ts.Transformer<ts.SourceFile> {
  const typeChecker = program.getTypeChecker();
  const { factory } = context;

  return (sourceFile: ts.SourceFile) => {
    function visit(node: ts.Node): ts.Node {
      if (
        ts.isInterfaceDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isVariableStatement(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isEnumDeclaration(node)
      ) {
        // Remove any types that are not exported.
        if (
          !node.modifiers?.find(m => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          return factory.createNotEmittedStatement(node);
        }
      }

      if (ts.isConstructorDeclaration(node)) {
        // Replace internal constructors with private constructors.
        return maybeHideConstructor(node);
      } else if (
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node)
      ) {
        // Remove any imports that reference internal APIs, while retaining
        // their public members.
        return prunePrivateImports(factory, program, host, sourceFile, node);
      } else if (
        ts.isPropertyDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessor(node)
      ) {
        // Remove any class and interface members that are prefixed with
        // underscores.
        if (hasPrivatePrefix(node.name as ts.Identifier)) {
          return factory.createNotEmittedStatement(node);
        }
      } else if (ts.isTypeReferenceNode(node)) {
        // For public types that refer internal types, find a public type that
        // we can refer to instead.
        const publicName = extractExportedSymbol(
          typeChecker,
          sourceFile,
          node.typeName
        );
        return publicName
          ? factory.updateTypeReferenceNode(
              node,
              factory.createIdentifier(publicName.name),
              node.typeArguments
            )
          : node;
      }

      return node;
    }

    function visitNodeAndChildren<T extends ts.Node>(node: T): T {
      return ts.visitEachChild(
        visit(node),
        childNode => visitNodeAndChildren(childNode),
        context
      ) as T;
    }
    return visitNodeAndChildren(sourceFile);
  };
}

const argv = yargs
  .options({
    input: {
      type: 'string',
      desc: 'The location of the index.ts file'
    },
    output: {
      type: 'string',
      desc: 'The location for the index.d.ts file'
    }
  })
  .parseSync();

if (argv.input && argv.output) {
  console.log('Removing private exports...');
  pruneDts(argv.input, argv.output);
  console.log('Removing unused imports...');
  removeUnusedImports(argv.output).then(() => console.log('Done.'));
}
