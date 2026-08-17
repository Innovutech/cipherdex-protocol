import ts from "typescript";

function blank(character) {
  return character === "\n" || character === "\r" ? character : " ";
}

function maskSource(source, maskLiterals) {
  let output = "";
  const contexts = [{ type: "code" }];

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    const context = contexts[contexts.length - 1];

    if (context.type === "code" || context.type === "template-expression") {
      if (character === "/" && next === "/") {
        output += "  ";
        index += 1;
        contexts.push({ type: "line-comment" });
      } else if (character === "/" && next === "*") {
        output += "  ";
        index += 1;
        contexts.push({ type: "block-comment" });
      } else if (character === '"' || character === "'") {
        output += maskLiterals ? " " : character;
        contexts.push({ type: "string", quote: character });
      } else if (character === "`") {
        output += maskLiterals ? " " : character;
        contexts.push({ type: "template" });
      } else if (context.type === "template-expression" && character === "{") {
        context.depth += 1;
        output += character;
      } else if (context.type === "template-expression" && character === "}") {
        context.depth -= 1;
        output += character;
        if (context.depth === 0) contexts.pop();
      } else {
        output += character;
      }
      continue;
    }

    if (context.type === "line-comment") {
      output += blank(character);
      if (character === "\n") contexts.pop();
      continue;
    }

    if (context.type === "block-comment") {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        contexts.pop();
      } else {
        output += blank(character);
      }
      continue;
    }

    if (context.type === "template") {
      if (character === "\\") {
        output += maskLiterals ? " " : character;
        if (next !== undefined) {
          output += maskLiterals ? blank(next) : next;
          index += 1;
        }
      } else if (character === "`" ) {
        output += maskLiterals ? " " : character;
        contexts.pop();
      } else if (character === "$" && next === "{") {
        output += maskLiterals ? " " : character;
        output += "{";
        index += 1;
        contexts.push({ type: "template-expression", depth: 1 });
      } else {
        output += maskLiterals ? blank(character) : character;
      }
      continue;
    }

    if (context.type === "string") {
      if (character === "\\") {
        output += maskLiterals ? " " : character;
        if (next !== undefined) {
          output += maskLiterals ? blank(next) : next;
          index += 1;
        }
      } else {
        output += maskLiterals ? blank(character) : character;
        if (character === context.quote) contexts.pop();
      }
    }
  }

  const unfinished = contexts[contexts.length - 1];
  if (unfinished.type === "block-comment") {
    throw new Error("Boundary lint source contains an unterminated block comment");
  }
  if (unfinished.type === "string" || unfinished.type === "template" || unfinished.type === "template-expression") {
    throw new Error("Boundary lint source contains an unterminated string literal");
  }

  return output;
}

export function maskSourceCommentsAndLiterals(source) {
  return maskSource(source, true);
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function uniqueFunctionParts(source, functionName, sourceLabel = "source") {
  const code = maskSourceCommentsAndLiterals(source);
  const declarationPattern = new RegExp(
    `\\bfunction\\s+${escapedRegExp(functionName)}(?:\\s*<[^;{}()]*>)?\\s*\\(`,
    "g",
  );
  const matches = [...code.matchAll(declarationPattern)];
  if (matches.length !== 1) {
    throw new Error(
      `${sourceLabel}: expected exactly one function ${functionName}, found ${matches.length}`,
    );
  }

  const start = matches[0].index;
  let openingBrace = -1;
  for (let index = start; index < code.length; index += 1) {
    if (code[index] === ";") {
      throw new Error(`${sourceLabel}: function ${functionName} has no body`);
    }
    if (code[index] === "{") {
      openingBrace = index;
      break;
    }
  }
  if (openingBrace < 0) {
    throw new Error(`${sourceLabel}: function ${functionName} has a malformed declaration`);
  }

  let depth = 0;
  for (let index = openingBrace; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    if (code[index] === "}") depth -= 1;
    if (depth === 0) {
      return {
        body: code.slice(openingBrace + 1, index),
        declaration: code.slice(start, openingBrace),
      };
    }
  }

  throw new Error(`${sourceLabel}: function ${functionName} has an unterminated body`);
}

export function uniqueFunctionBody(source, functionName, sourceLabel) {
  return uniqueFunctionParts(source, functionName, sourceLabel).body;
}

export function uniqueFunctionDeclaration(source, functionName, sourceLabel) {
  return uniqueFunctionParts(source, functionName, sourceLabel).declaration;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) current = current.expression;
  return current;
}

function callName(expression) {
  expression = unwrapExpression(expression);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const receiver = callName(expression.expression);
    return receiver ? `${receiver}.${expression.name.text}` : expression.name.text;
  }
  if (ts.isElementAccessExpression(expression)) {
    const receiver = callName(expression.expression);
    const member = expression.argumentExpression;
    if (ts.isStringLiteral(member) || ts.isNoSubstitutionTemplateLiteral(member)) {
      return receiver ? `${receiver}.${member.text}` : member.text;
    }
    return receiver ? `${receiver}.[computed]` : "[computed]";
  }
  return "";
}

function assertNoEagerBlockingWork(sourceFile, sourceLabel, blockingCallees) {
  const aliases = new Map();
  const callableBindings = new Map();
  const executingCallables = new Set();
  const stringAliases = new Map();

  const collectFunctionDeclarations = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const existing = callableBindings.get(node.name.text) ?? [];
      existing.push(node);
      callableBindings.set(node.name.text, existing);
    }
    ts.forEachChild(node, collectFunctionDeclarations);
  };
  collectFunctionDeclarations(sourceFile);

  const resolvedName = (expression) => {
    expression = unwrapExpression(expression);
    if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? expression.text;
    if (ts.isPropertyAccessExpression(expression)) {
      const receiver = resolvedName(expression.expression);
      return receiver ? `${receiver}.${expression.name.text}` : expression.name.text;
    }
    if (ts.isElementAccessExpression(expression)) {
      const receiver = resolvedName(expression.expression);
      const member = unwrapExpression(expression.argumentExpression);
      const key = ts.isStringLiteral(member) || ts.isNoSubstitutionTemplateLiteral(member)
        ? member.text
        : ts.isIdentifier(member)
          ? stringAliases.get(member.text)
          : undefined;
      return key ? `${receiver}.${key}` : `${receiver}.[computed]`;
    }
    return "";
  };

  const hasStaticModifier = (node) => (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
    )
  );

  const visitEagerClass = (node) => {
    for (const clause of node.heritageClauses ?? []) {
      for (const type of clause.types) visitEager(type.expression);
    }
    for (const member of node.members) {
      if (member.name && ts.isComputedPropertyName(member.name)) {
        visitEager(member.name.expression);
      }
      if (ts.isClassStaticBlockDeclaration(member)) {
        visitEager(member.body);
      } else if (
        ts.isPropertyDeclaration(member) &&
        hasStaticModifier(member) &&
        member.initializer
      ) {
        visitEager(member.initializer);
      }
    }
  };

  const visitInvokedCallable = (callable) => {
    if (executingCallables.has(callable)) return;
    executingCallables.add(callable);
    try {
      for (const parameter of callable.parameters) {
        if (parameter.initializer) visitEager(parameter.initializer);
      }
      if (callable.body) visitEager(callable.body);
    } finally {
      executingCallables.delete(callable);
    }
  };

  const visitEager = (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) return;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      visitEagerClass(node);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) visitEager(node.initializer);
      registerBinding(node.name, node.initializer);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      blockingCallees.includes(resolvedName(node.expression))
    ) {
      throw new Error(
        `${sourceLabel}: artifact or network work executes at module initialization`,
      );
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
        visitInvokedCallable(callee);
      } else {
        const resolvedCallee = resolvedName(callee);
        if (resolvedCallee !== "main") {
          for (const callable of callableBindings.get(resolvedCallee) ?? []) {
            visitInvokedCallable(callable);
          }
        }
      }
    }
    ts.forEachChild(node, visitEager);
  };

  const registerBinding = (name, initializer) => {
    if (!initializer) return;
    initializer = unwrapExpression(initializer);
    if (ts.isIdentifier(name)) {
      if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) {
        callableBindings.set(name.text, [initializer]);
        return;
      }
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        stringAliases.set(name.text, initializer.text);
        return;
      }
      const resolved = resolvedName(initializer);
      if (resolved) aliases.set(name.text, resolved);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      const receiver = resolvedName(initializer);
      if (!receiver) return;
      for (const element of name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const propertyName = element.propertyName ?? element.name;
        if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) {
          aliases.set(element.name.text, `${receiver}.${propertyName.text}`);
        }
      }
    }
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) continue;
    visitEager(statement);
  }
}

function uniqueMainFunction(sourceFile, sourceLabel) {
  const matches = sourceFile.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "main" &&
      statement.body,
  );
  if (matches.length !== 1) {
    throw new Error(`${sourceLabel}: expected exactly one top-level main function, found ${matches.length}`);
  }
  return matches[0];
}

function exactAwaitedHreRunCommand(statement) {
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) {
    return undefined;
  }
  const expression = statement.expression.expression;
  if (
    !ts.isCallExpression(expression) ||
    callName(expression.expression) !== "hre.run" ||
    expression.arguments.length !== 1
  ) return undefined;
  const command = expression.arguments[0];
  return ts.isStringLiteral(command) || ts.isNoSubstitutionTemplateLiteral(command)
    ? command.text
    : undefined;
}

export function assertEarlyHardhatRunSequence(
  source,
  sourceLabel,
  commands,
  blockingCallees,
) {
  const sourceFile = ts.createSourceFile(
    sourceLabel,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assertNoEagerBlockingWork(sourceFile, sourceLabel, blockingCallees);
  const main = uniqueMainFunction(sourceFile, sourceLabel);
  const commandStatements = new Map();
  for (const statement of main.body.statements) {
    const command = exactAwaitedHreRunCommand(statement);
    if (!command) continue;
    if (commandStatements.has(command)) {
      throw new Error(`${sourceLabel}: main invokes hre.run(${command}) more than once`);
    }
    commandStatements.set(command, statement);
  }

  if (main.body.statements.length < commands.length) {
    throw new Error(`${sourceLabel}: main must begin with Hardhat clean/compile freshness`);
  }
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const statement = main.body.statements[index];
    if (exactAwaitedHreRunCommand(statement) !== command) {
      throw new Error(
        `${sourceLabel}: main must begin with direct hre.run(${commands.join(", ")}) calls`,
      );
    }
  }
  const previousPosition = main.body.statements[commands.length - 1].getEnd();

  let firstBlockingCall = Number.POSITIVE_INFINITY;
  const visit = (node) => {
    if (ts.isCallExpression(node) && blockingCallees.includes(callName(node.expression))) {
      firstBlockingCall = Math.min(firstBlockingCall, node.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(main.body);
  if (Number.isFinite(firstBlockingCall) && previousPosition >= firstBlockingCall) {
    throw new Error(`${sourceLabel}: Hardhat compile freshness runs after artifact or network work`);
  }
}
