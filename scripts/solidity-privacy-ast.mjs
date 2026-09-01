function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== "object") return;
  visit(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, nextAncestors);
    } else if (value && typeof value === "object") {
      walk(value, visit, nextAncestors);
    }
  }
}

function nearest(ancestors, nodeType) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    if (ancestors[index].nodeType === nodeType) return ancestors[index];
  }
  return undefined;
}

function containsNode(root, target) {
  if (!root || typeof root !== "object") return false;
  if (root === target) return true;
  for (const value of Object.values(root)) {
    if (Array.isArray(value) && value.some((child) => containsNode(child, target))) return true;
    if (value && typeof value === "object" && containsNode(value, target)) return true;
  }
  return false;
}

function bodyStatements(body) {
  if (!body) return [];
  if (body.nodeType === "Block") return body.statements ?? [];
  return [body];
}

function isExactCustomRevertBody(body, errorName) {
  const statements = bodyStatements(body);
  if (statements.length !== 1 || statements[0].nodeType !== "RevertStatement") return false;
  const call = statements[0].errorCall;
  return (
    call?.nodeType === "FunctionCall" &&
    call.expression?.nodeType === "Identifier" &&
    (errorName === undefined || call.expression.name === errorName) &&
    (call.arguments?.length ?? 0) === 0
  );
}

function directContainingStatement(functionBody, ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (functionBody.statements?.includes(ancestor)) return ancestor;
  }
  return undefined;
}

function solidityCallName(expression) {
  if (expression?.nodeType === "Identifier") return expression.name;
  if (expression?.nodeType === "ElementaryTypeNameExpression") {
    return expression.typeName?.name ?? "";
  }
  if (expression?.nodeType === "MemberAccess") {
    const receiver = solidityCallName(expression.expression);
    return receiver ? `${receiver}.${expression.memberName}` : expression.memberName;
  }
  return "";
}

function mpcDecryptDeclarationIds(compilationSources) {
  const ids = new Set();
  for (const source of Object.values(compilationSources)) {
    if (!source?.ast) continue;
    walk(source.ast, (node, ancestors) => {
      if (node.nodeType !== "FunctionDefinition" || node.name !== "decrypt") return;
      const contract = nearest(ancestors, "ContractDefinition");
      if (contract?.name === "MpcCore") ids.add(node.id);
    });
  }
  if (ids.size === 0) throw new Error("Compiled Solidity AST omits MpcCore.decrypt declarations");
  return ids;
}

function assertRouterIndexDeclassification(path, call, ancestors) {
  const contract = nearest(ancestors, "ContractDefinition");
  const functionNode = nearest(ancestors, "FunctionDefinition");
  const declarationStatement = nearest(ancestors, "VariableDeclarationStatement");
  if (
    !(
      (
        path === "contracts/ConfidentialBestExecutionRouter.sol" &&
        contract?.name === "ConfidentialBestExecutionRouter"
      ) ||
      (
        path === "contracts/ObservableConfidentialBestExecutionRouter.sol" &&
        contract?.name === "ObservableConfidentialBestExecutionRouter"
      )
    ) ||
    functionNode?.name !== "_selectBest" ||
    functionNode.visibility !== "internal" ||
    declarationStatement?.initialValue !== call ||
    declarationStatement.declarations?.length !== 1
  ) {
    throw new Error(`${path}: plaintext MPC uint decryption is outside the reviewed route-index boundary`);
  }

  const declaration = declarationStatement.declarations[0];
  const candidateParameter = functionNode.parameters?.parameters?.find(
    (parameter) =>
      parameter.name === "candidates" &&
      /(?:^|\.)CandidateSet$/.test(parameter.typeDescriptions?.typeString ?? ""),
  );
  if (!candidateParameter) {
    throw new Error(`${path}: reviewed route index is not bound to the canonical CandidateSet parameter`);
  }

  const candidateMember = (node, memberName) =>
    node?.nodeType === "MemberAccess" &&
    node.memberName === memberName &&
    node.expression?.nodeType === "Identifier" &&
    node.expression.referencedDeclaration === candidateParameter.id;
  const containsCanonicalCandidateMember = (root) => {
    let found = false;
    walk(root, (node) => {
      if (
        node.nodeType === "MemberAccess" &&
        ["count", "pools", "feeTiers", "initializationStrategies", "zeroForOne"].includes(
          node.memberName,
        ) &&
        candidateMember(node, node.memberName)
      ) found = true;
    });
    return found;
  };

  walk(functionNode.body, (node, nodeAncestors) => {
    if (
      node.nodeType === "VariableDeclaration" &&
      /(?:^|\.)CandidateSet$/.test(node.typeDescriptions?.typeString ?? "")
    ) {
      throw new Error(`${path}: reviewed route selection introduces a mutable CandidateSet alias`);
    }
    if (node.nodeType === "InlineAssembly") {
      throw new Error(`${path}: reviewed route selection cannot use inline assembly`);
    }
    if (
      node.nodeType === "MemberAccess" &&
      ["pools", "feeTiers", "initializationStrategies"].includes(node.memberName) &&
      candidateMember(node, node.memberName)
    ) {
      const parent = nodeAncestors[nodeAncestors.length - 1];
      if (parent?.nodeType !== "IndexAccess" || parent.baseExpression !== node) {
        throw new Error(`${path}: canonical CandidateSet array escapes direct indexed access`);
      }
    }
    if (node.nodeType === "Assignment") {
      const target = node.leftHandSide;
      if (
        (target?.nodeType === "Identifier" &&
          target.referencedDeclaration === candidateParameter.id) ||
        containsCanonicalCandidateMember(target)
      ) {
        throw new Error(`${path}: canonical CandidateSet is mutated during route selection`);
      }
    }
    if (
      node.nodeType === "UnaryOperation" &&
      node.operator === "delete" &&
      containsCanonicalCandidateMember(node.subExpression)
    ) {
      throw new Error(`${path}: canonical CandidateSet is deleted during route selection`);
    }
    if (
      node.nodeType === "FunctionCall" &&
      node.arguments?.some(
        (argument) =>
          argument.nodeType === "Identifier" &&
          argument.referencedDeclaration === candidateParameter.id,
      )
    ) {
      throw new Error(`${path}: canonical CandidateSet escapes to an unreviewed helper`);
    }
  });

  const references = [];
  walk(functionNode.body, (node, nodeAncestors) => {
    if (node.nodeType === "Identifier" && node.referencedDeclaration === declaration.id) {
      references.push({
        node,
        parent: nodeAncestors[nodeAncestors.length - 1],
        ancestors: nodeAncestors,
      });
    }
  });
  if (references.length !== 4) {
    throw new Error(`${path}: decrypted route index has an unexpected use count`);
  }

  const allowedMembers = new Set([
    "pools",
    "feeTiers",
    "initializationStrategies",
  ]);
  let boundCheck;
  const indexedMembers = new Set();
  const indexedAccesses = [];
  for (const reference of references) {
    const parent = reference.parent;
    if (
      parent?.nodeType === "BinaryOperation" &&
      parent.operator === ">=" &&
      parent.leftExpression === reference.node &&
      candidateMember(parent.rightExpression, "count")
    ) {
      const ifStatement = nearest(reference.ancestors, "IfStatement");
      if (boundCheck || ifStatement?.condition !== parent) {
        throw new Error(`${path}: decrypted route index lacks one exact canonical bound check`);
      }
      if (
        nearest(reference.ancestors, "Block") !== functionNode.body ||
        ifStatement.falseBody ||
        !isExactCustomRevertBody(ifStatement.trueBody, "InvalidCanonicalPool")
      ) {
        throw new Error(`${path}: route-index bound is not one unconditional canonical guard`);
      }
      boundCheck = ifStatement;
      continue;
    }
    if (
      parent?.nodeType === "IndexAccess" &&
      parent.indexExpression === reference.node &&
      parent.baseExpression?.nodeType === "MemberAccess" &&
      allowedMembers.has(parent.baseExpression.memberName) &&
      candidateMember(parent.baseExpression, parent.baseExpression.memberName)
    ) {
      indexedMembers.add(parent.baseExpression.memberName);
      indexedAccesses.push({
        access: parent,
        statement: directContainingStatement(functionNode.body, reference.ancestors),
      });
      continue;
    }
    throw new Error(`${path}: decrypted route index reaches an unreviewed sink`);
  }
  if (!boundCheck || indexedMembers.size !== 3 || indexedAccesses.length !== 3) {
    throw new Error(`${path}: decrypted route index is not limited to the bounded pool/tier/strategy lookup`);
  }
  const boundPosition = functionNode.body.statements?.indexOf(boundCheck) ?? -1;
  if (
    boundPosition < 0 ||
    indexedAccesses.some(({ statement }) => {
      const position = functionNode.body.statements?.indexOf(statement) ?? -1;
      return position <= boundPosition;
    })
  ) {
    throw new Error(`${path}: canonical route-index bound does not dominate every lookup`);
  }
}

function assertObservablePriceDeclassification(path, call, ancestors) {
  const contract = nearest(ancestors, "ContractDefinition");
  const functionNode = nearest(ancestors, "FunctionDefinition");
  const declarationStatement = nearest(ancestors, "VariableDeclarationStatement");
  const functionName = functionNode?.name;
  const expectedVariable = (
    functionName === "_initializePublicObservation" ||
    functionName === "_recordSwapObservation"
  ) ? "bucket" : undefined;
  if (
    path !== "contracts/ObservableConfidentialCPMM.sol" ||
    contract?.name !== "ObservableConfidentialCPMM" ||
    functionNode?.visibility !== "internal" ||
    expectedVariable === undefined ||
    declarationStatement?.initialValue !== call ||
    declarationStatement.declarations?.length !== 1 ||
    declarationStatement.declarations[0]?.name !== expectedVariable
  ) {
    throw new Error(`${path}: plaintext MPC price decryption is outside the reviewed observation boundary`);
  }

  const declaration = declarationStatement.declarations[0];
  const references = [];
  walk(functionNode.body, (node, nodeAncestors) => {
    if (node.nodeType === "Identifier" && node.referencedDeclaration === declaration.id) {
      references.push({ node, parent: nodeAncestors.at(-1) });
    }
    if (node.nodeType === "InlineAssembly") {
      throw new Error(`${path}: reviewed observation declassification cannot use inline assembly`);
    }
  });
  const expectedReferences = functionName === "_initializePublicObservation" ? 1 : 2;
  if (references.length !== expectedReferences) {
    throw new Error(`${path}: decrypted observation bucket has an unexpected use count`);
  }
  const publishReferences = references.filter(({ node, parent }) =>
    parent?.nodeType === "FunctionCall" &&
    solidityCallName(parent.expression) === "_publishObservation" &&
    parent.arguments?.[0] === node
  );
  const equalityReferences = references.filter(({ node, parent }) =>
    parent?.nodeType === "BinaryOperation" &&
    parent.operator === "==" &&
    parent.leftExpression === node &&
    parent.rightExpression?.nodeType === "Identifier" &&
    parent.rightExpression.name === "referencePrice"
  );
  if (
    publishReferences.length !== 1 ||
    equalityReferences.length !== (functionName === "_recordSwapObservation" ? 1 : 0)
  ) {
    throw new Error(`${path}: decrypted observation bucket reaches an unreviewed sink`);
  }
}

function isInitializedFalseStatement(statement) {
  const expression = statement?.nodeType === "ExpressionStatement"
    ? statement.expression
    : undefined;
  return (
    expression?.nodeType === "Assignment" &&
    expression.operator === "=" &&
    expression.leftHandSide?.nodeType === "Identifier" &&
    expression.leftHandSide.name === "initialized" &&
    expression.rightHandSide?.nodeType === "Literal" &&
    expression.rightHandSide.kind === "bool" &&
    expression.rightHandSide.value === "false"
  );
}

function isTerminalProtocolFeeDepositStatement(statement) {
  const expression = statement?.nodeType === "ExpressionStatement"
    ? statement.expression
    : undefined;
  return (
    expression?.nodeType === "FunctionCall" &&
    expression.expression?.nodeType === "Identifier" &&
    expression.expression.name === "_depositTerminalProtocolFees" &&
    expression.arguments?.length === 0
  );
}

function isClearCurrentObservationStatement(statement) {
  const expression = statement?.nodeType === "ExpressionStatement"
    ? statement.expression
    : undefined;
  return (
    expression?.nodeType === "FunctionCall" &&
    expression.expression?.nodeType === "Identifier" &&
    expression.expression.name === "_clearCurrentObservation" &&
    expression.arguments?.length === 0
  );
}

function isClearInitialPriceReferenceStatement(statement) {
  const expression = statement?.nodeType === "ExpressionStatement"
    ? statement.expression
    : undefined;
  return (
    expression?.nodeType === "UnaryOperation" &&
    expression.operator === "delete" &&
    expression.subExpression?.nodeType === "Identifier" &&
    expression.subExpression.name === "initialPriceReferenceX18"
  );
}

function isReviewedFullExitBody(path, body) {
  const statements = bodyStatements(body);
  if (path === "contracts/ConfidentialCPMM.sol") {
    if (statements.length === 1) {
      return isInitializedFalseStatement(statements[0]);
    }
    return (
      statements.length === 2 &&
      isTerminalProtocolFeeDepositStatement(statements[0]) &&
      isInitializedFalseStatement(statements[1])
    );
  }
  return (
    path === "contracts/ObservableConfidentialCPMM.sol" &&
    statements.length === 4 &&
    isTerminalProtocolFeeDepositStatement(statements[0]) &&
    isInitializedFalseStatement(statements[1]) &&
    isClearInitialPriceReferenceStatement(statements[2]) &&
    isClearCurrentObservationStatement(statements[3])
  );
}

function isSideEffectFreeMpcDecryptArgument(expression) {
  let valid = true;
  walk(expression, (node) => {
    if (node.nodeType !== "FunctionCall") return;
    const callName = solidityCallName(node.expression);
    const isMpcOperation = callName.startsWith("MpcCore.") && callName !== "MpcCore.decrypt";
    const isTypeConversion = node.expression?.nodeType === "ElementaryTypeNameExpression";
    if (!isMpcOperation && !isTypeConversion) valid = false;
  });
  return valid;
}

function isPureDecryptedBooleanPredicate(expression) {
  if (
    expression?.nodeType === "FunctionCall" &&
    expression.typeDescriptions?.typeString === "bool" &&
    expression.expression?.nodeType === "MemberAccess" &&
    expression.expression.memberName === "decrypt" &&
    expression.expression.expression?.nodeType === "Identifier" &&
    expression.expression.expression.name === "MpcCore" &&
    expression.arguments?.length === 1 &&
    isSideEffectFreeMpcDecryptArgument(expression.arguments[0])
  ) return true;
  if (expression?.nodeType === "UnaryOperation" && expression.operator === "!") {
    return isPureDecryptedBooleanPredicate(expression.subExpression);
  }
  return false;
}

function assertReviewedFullExitBoolean(path, call, ancestors) {
  const contract = nearest(ancestors, "ContractDefinition");
  const functionNode = nearest(ancestors, "FunctionDefinition");
  const declarationStatement = nearest(ancestors, "VariableDeclarationStatement");
  if (
    !(
      (
        path === "contracts/ConfidentialCPMM.sol" &&
        contract?.name === "ConfidentialCPMM"
      ) ||
      (
        path === "contracts/ObservableConfidentialCPMM.sol" &&
        contract?.name === "ObservableConfidentialCPMM"
      )
    ) ||
    functionNode?.name !== "removeLiquidity" ||
    declarationStatement?.initialValue !== call ||
    declarationStatement.declarations?.length !== 1 ||
    declarationStatement.declarations[0]?.name !== "isFullExit" ||
    declarationStatement.declarations[0]?.typeDescriptions?.typeString !== "bool"
  ) {
    throw new Error(`${path}: plaintext MPC bool local is outside the reviewed full-exit boundary`);
  }

  const declaration = declarationStatement.declarations[0];
  const references = [];
  walk(functionNode.body, (node, nodeAncestors) => {
    if (node.nodeType === "Identifier" && node.referencedDeclaration === declaration.id) {
      references.push({ node, ancestors: nodeAncestors });
    }
  });
  if (references.length !== 1) {
    throw new Error(`${path}: reviewed full-exit boolean has an unexpected use count`);
  }

  const reference = references[0];
  const parent = reference.ancestors[reference.ancestors.length - 1];
  if (
    parent?.nodeType !== "IfStatement" ||
    parent.condition !== reference.node ||
    parent.falseBody ||
    !isReviewedFullExitBody(path, parent.trueBody)
  ) {
    throw new Error(`${path}: plaintext MPC full-exit boolean reaches an unreviewed sink`);
  }
}

function assertBooleanControlFlowDeclassification(path, call, ancestors) {
  const directIf = [...ancestors].reverse().find(
    (ancestor) => ancestor.nodeType === "IfStatement" && containsNode(ancestor.condition, call),
  );
  if (directIf) {
    if (
      !isPureDecryptedBooleanPredicate(directIf.condition) ||
      directIf.falseBody ||
      !isExactCustomRevertBody(directIf.trueBody)
    ) {
      throw new Error(`${path}: plaintext MPC bool condition is not an exact fail-closed revert guard`);
    }
    return;
  }

  assertReviewedFullExitBoolean(path, call, ancestors);
}

export function assertCompiledPrivacyDecryptBoundary(compilationSources, targetPaths) {
  for (const path of targetPaths) {
    const ast = compilationSources[path]?.ast;
    if (!ast) throw new Error(`${path}: compiled Solidity AST is unavailable`);
  }

  const decryptIds = mpcDecryptDeclarationIds(compilationSources);
  let plaintextUintDecryptions = 0;
  for (const path of targetPaths) {
    const ast = compilationSources[path]?.ast;
    walk(ast, (node, ancestors) => {
      if (!decryptIds.has(node.referencedDeclaration)) return;
      const parent = ancestors.at(-1);
      if (parent?.nodeType !== "FunctionCall" || parent.expression !== node) {
        throw new Error(
          `${path}: MpcCore.decrypt may not be aliased, stored, or referenced outside a direct call`,
        );
      }
    });
    walk(ast, (node, ancestors) => {
      if (
        node.nodeType !== "FunctionCall" ||
        !decryptIds.has(node.expression?.referencedDeclaration)
      ) return;
      if (node.typeDescriptions?.typeString === "bool") {
        assertBooleanControlFlowDeclassification(path, node, ancestors);
        return;
      }
      if (
        node.typeDescriptions?.typeString !== "uint256" ||
        node.arguments?.[0]?.typeDescriptions?.typeString !== "gtUint256"
      ) {
        throw new Error(`${path}: unsupported plaintext MPC decryption type`);
      }
      plaintextUintDecryptions += 1;
      if (path === "contracts/ObservableConfidentialCPMM.sol") {
        assertObservablePriceDeclassification(path, node, ancestors);
      } else {
        assertRouterIndexDeclassification(path, node, ancestors);
      }
    });
  }
  return plaintextUintDecryptions;
}
