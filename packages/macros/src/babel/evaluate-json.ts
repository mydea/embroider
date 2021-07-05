import type { NodePath } from '@babel/traverse';
import type {
  Identifier,
  ObjectExpression,
  MemberExpression,
  Expression,
  ExpressionStatement,
  File,
  CallExpression,
  OptionalMemberExpression,
} from '@babel/types';
import type * as Babel from '@babel/core';
import State, { owningPackage } from './state';
import dependencySatisfies from './dependency-satisfies';
import moduleExists from './module-exists';
import getConfig from './get-config';

type OpValue = string | boolean | number;

const binops: { [operator: string]: any } = {
  '||': function (a: OpValue, b: OpValue) {
    return a || b;
  },
  '&&': function (a: OpValue, b: OpValue) {
    return a && b;
  },
  '|': function (a: any, b: any) {
    return a | b;
  },
  '^': function (a: any, b: any) {
    return a ^ b;
  },
  '&': function (a: any, b: any) {
    return a & b;
  },
  '==': function (a: OpValue, b: OpValue) {
    // eslint-disable-next-line eqeqeq
    return a == b;
  },
  '!=': function (a: OpValue, b: OpValue) {
    // eslint-disable-next-line eqeqeq
    return a != b;
  },
  '===': function (a: OpValue, b: OpValue) {
    return a === b;
  },
  '!==': function (a: OpValue, b: OpValue) {
    return a !== b;
  },
  '<': function (a: OpValue, b: OpValue) {
    return a < b;
  },
  '>': function (a: OpValue, b: OpValue) {
    return a > b;
  },
  '<=': function (a: OpValue, b: OpValue) {
    return a <= b;
  },
  '>=': function (a: OpValue, b: OpValue) {
    return a >= b;
  },
  '<<': function (a: any, b: any) {
    return a << b;
  },
  '>>': function (a: any, b: any) {
    return a >> b;
  },
  '>>>': function (a: any, b: any) {
    return a >>> b;
  },
  '+': function (a: any, b: any) {
    return a + b;
  },
  '-': function (a: any, b: any) {
    return a - b;
  },
  '*': function (a: any, b: any) {
    return a * b;
  },
  '/': function (a: any, b: any) {
    return a / b;
  },
  '%': function (a: any, b: any) {
    return a % b;
  },
  '??': function (a: any, b: any) {
    if (a === null || a === undefined) {
      return b;
    }
    return a;
  },
};

const unops: { [operator: string]: any } = {
  '-': function (a: OpValue) {
    return -a;
  },
  '+': function (a: OpValue) {
    return +a;
  },
  '~': function (a: OpValue) {
    return ~a;
  },
  '!': function (a: OpValue) {
    return !a;
  },
  void: function () {
    return undefined;
  },
};

export interface ConfidentResult {
  confident: true;
  value: any;
}

export interface UnknownResult {
  confident: false;
}

export type EvaluateResult = ConfidentResult | UnknownResult;

// this is needed to make our strict types work when inter-operating with
// babel's own built-in evaluator
function isConfidentResult(result: { confident: boolean; value: any }): result is ConfidentResult {
  return result.confident;
}

export interface EvaluationEnv {
  knownPaths?: Map<NodePath, EvaluateResult>;
  locals?: { [localVar: string]: any };
  state?: State;
}

export class Evaluator {
  private knownPaths: Map<NodePath, EvaluateResult>;
  private locals: { [localVar: string]: any };
  private state: State | undefined;

  constructor(env: EvaluationEnv = {}) {
    this.knownPaths = env.knownPaths || new Map();
    this.locals = env.locals || {};
    this.state = env.state;
  }

  evaluateMember(path: NodePath<MemberExpression | OptionalMemberExpression>, optionalChain: boolean): EvaluateResult {
    let propertyPath = assertNotArray(path.get('property'));
    let property: EvaluateResult;
    if (path.node.computed) {
      property = this.evaluate(propertyPath);
    } else {
      property = this.evaluateKey(propertyPath);
    }
    if (property.confident) {
      let objectPath = path.get('object');
      let object = this.evaluate(objectPath);
      if (object.confident) {
        let confidentObject = object;
        let confidentProperty = property;
        return {
          confident: true,
          get value() {
            if (optionalChain) {
              return confidentObject.value != null
                ? confidentObject.value[confidentProperty.value]
                : confidentObject.value;
            } else {
              return confidentObject.value[confidentProperty.value];
            }
          },
        };
      }
    }
    return { confident: false };
  }

  evaluateKey(path: NodePath): EvaluateResult {
    let first = this.evaluate(path);
    if (first.confident) {
      return first;
    }
    if (path.isIdentifier()) {
      return { confident: true, value: path.node.name };
    }
    return { confident: false };
  }

  evaluate(path: NodePath): EvaluateResult {
    let known = this.knownPaths.get(path);
    if (known) {
      return known;
    }
    let result = this.realEvaluate(path);
    return result;
  }

  private realEvaluate(path: NodePath): EvaluateResult {
    let builtIn = path.evaluate();
    if (isConfidentResult(builtIn)) {
      return builtIn;
    }

    if (path.isMemberExpression()) {
      return this.evaluateMember(path, false);
    }

    // Here we are glossing over the lack of a real OptionalMemberExpression type
    // in our @babel/traverse typings.
    if (path.node.type === 'OptionalMemberExpression') {
      return this.evaluateMember(path as NodePath<OptionalMemberExpression>, true);
    }

    if (path.isStringLiteral()) {
      return { confident: true, value: path.node.value };
    }

    if (path.isNumericLiteral()) {
      return { confident: true, value: path.node.value };
    }

    if (path.isBooleanLiteral()) {
      return { confident: true, value: path.node.value };
    }

    if (path.isNullLiteral()) {
      return { confident: true, value: null };
    }

    if (path.isObjectExpression()) {
      let props = assertArray(path.get('properties')).map(p => {
        let key = assertNotArray(p.get('key'));
        let keyEvalValue = this.evaluateKey(key);
        let value = assertNotArray(p.get('value'));
        let valueEvalValue = this.evaluate(value);
        return [keyEvalValue, valueEvalValue];
      });
      for (let [k, v] of props) {
        if (!k.confident || !v.confident) {
          return { confident: false };
        }
      }
      let confidentProps = props as ConfidentResult[][];
      return {
        confident: true,
        get value() {
          let result: any = {};
          for (let [k, v] of confidentProps) {
            result[k.value] = v.value;
          }
          return result;
        },
      };
    }

    if (path.isArrayExpression()) {
      let elements = path.get('elements').map(element => {
        return this.evaluate(element as NodePath);
      });
      if (elements.every(element => element.confident)) {
        let confidentElements = elements as ConfidentResult[];
        return {
          confident: true,
          get value() {
            return confidentElements.map(element => element.value);
          },
        };
      }
    }

    if (path.isAssignmentExpression()) {
      let leftPath = path.get('left');
      if (leftPath.isIdentifier()) {
        let rightPath = path.get('right');
        let right = this.evaluate(rightPath);
        if (right.confident) {
          this.locals[leftPath.node.name] = right.value;
          return right;
        }
      }
    }

    if (path.isCallExpression()) {
      let result = this.maybeEvaluateRuntimeConfig(path);
      if (result.confident) {
        return result;
      }
      result = this.evaluateMacroCall(path);
      if (result.confident) {
        return result;
      }
    }

    if (path.isLogicalExpression() || path.isBinaryExpression()) {
      let operator = path.node.operator as string;
      if (binops[operator]) {
        let leftOperand = this.evaluate(path.get('left') as NodePath<Expression>);
        if (leftOperand.confident) {
          let rightOperand = this.evaluate(path.get('right') as NodePath<Expression>);
          if (leftOperand.confident && rightOperand.confident) {
            let value = binops[operator](leftOperand.value, rightOperand.value);
            return { confident: true, value };
          }
        }
      }
      return { confident: false };
    }

    if (path.isConditionalExpression()) {
      let test = this.evaluate(path.get('test'));
      if (test.confident) {
        let result = test.value ? this.evaluate(path.get('consequent')) : this.evaluate(path.get('alternate'));
        if (result.confident) {
          return result;
        }
      }
    }

    if (path.isUnaryExpression()) {
      let operator = path.node.operator as string;
      if (unops[operator]) {
        let operand = this.evaluate(path.get('argument') as NodePath<Expression>);
        if (operand.confident) {
          let value = unops[operator](operand.value);
          return { confident: true, value };
        }
      }
      return { confident: false };
    }

    if (path.isIdentifier()) {
      if (!this.locals.hasOwnProperty(path.node.name)) {
        return { confident: false };
      }
      return { confident: true, value: this.locals[path.node.name] };
    }

    return { confident: false };
  }

  // This handles the presence of our runtime-mode getConfig functions. We want
  // to designate them as { confident: true }, because it's important that we
  // give feedback even in runtime-mode if the developer is trying to pass
  // non-static arguments somewhere they're not supposed to. But we don't
  // actually want to calculate their value here because that has been deferred
  // to runtime. That's why we've made `value` lazy. It lets us check the
  // confidence without actually forcing the value.
  private maybeEvaluateRuntimeConfig(path: NodePath<CallExpression>): EvaluateResult {
    let callee = path.get('callee');
    if (callee.isIdentifier()) {
      let { name } = callee.node;
      // Does the identifier refer to our runtime config?
      if (this.state?.neededRuntimeImports.get(name) === 'config') {
        return {
          confident: true,
          get value() {
            throw new Error(`bug in @embroider/macros: didn't expect to need to evaluate this value`);
          },
        };
      }
    }
    return { confident: false };
  }

  evaluateMacroCall(path: NodePath<CallExpression>): EvaluateResult {
    if (!this.state) {
      return { confident: false };
    }
    let callee = path.get('callee');
    if (callee.referencesImport('@embroider/macros', 'dependencySatisfies')) {
      return { confident: true, value: dependencySatisfies(path, this.state) };
    }
    if (callee.referencesImport('@embroider/macros', 'moduleExists')) {
      return { confident: true, value: moduleExists(path, this.state) };
    }
    if (callee.referencesImport('@embroider/macros', 'getConfig')) {
      return { confident: true, value: getConfig(path, this.state, 'package') };
    }
    if (callee.referencesImport('@embroider/macros', 'getOwnConfig')) {
      return { confident: true, value: getConfig(path, this.state, 'own') };
    }
    if (callee.referencesImport('@embroider/macros', 'getGlobalConfig')) {
      return { confident: true, value: getConfig(path, this.state, 'getGlobalConfig') };
    }
    if (callee.referencesImport('@embroider/macros', 'isDevelopingApp')) {
      return {
        confident: true,
        value: Boolean(
          this.state.opts.appPackageRoot &&
            this.state.opts.isDevelopingPackageRoots.includes(this.state.opts.appPackageRoot)
        ),
      };
    }
    if (callee.referencesImport('@embroider/macros', 'isDevelopingThisPackage')) {
      return {
        confident: true,
        value: this.state.opts.isDevelopingPackageRoots.includes(owningPackage(path, this.state).root),
      };
    }
    if (callee.referencesImport('@embroider/macros', 'isTesting')) {
      let g = getConfig(path, this.state, 'getGlobalConfig') as any;
      let e = g && g['@embroider/macros'];
      let value = Boolean(e && e.isTesting);
      return { confident: true, value };
    }
    return { confident: false };
  }
}

// these next two functions are here because the type definitions we're using
// don't seem to know exactly which NodePath properties are arrays and which
// aren't.
export function assertNotArray<T>(input: T | T[]): T {
  if (Array.isArray(input)) {
    throw new Error(`bug: not supposed to be an array`);
  }
  return input;
}
export function assertArray<T>(input: T | T[]): T[] {
  if (!Array.isArray(input)) {
    throw new Error(`bug: supposed to be an array`);
  }
  return input;
}

export function buildLiterals(value: unknown | undefined, babelContext: typeof Babel): Identifier | ObjectExpression {
  if (typeof value === 'undefined') {
    return babelContext.types.identifier('undefined');
  }
  let statement = babelContext.parse(`a(${JSON.stringify(value)})`) as File;
  let expression = (statement.program.body[0] as ExpressionStatement).expression as CallExpression;
  return expression.arguments[0] as ObjectExpression;
}
