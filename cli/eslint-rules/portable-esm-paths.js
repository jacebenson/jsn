// Deliberately local analysis: immutable lexical aliases, not arbitrary data flow.
const flags = /^(--import|--loader|--experimental-loader)(?:=(.*))?$/s;
const rawPath = value => /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value);
const property = node => node?.type === 'MemberExpression' && !node.computed ? node.property.name : null;

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Use portable conversions between filesystem paths and Node ESM file URLs' },
    schema: [],
    messages: {
      fileUrl: 'Raw filesystem path used as a Node ESM module specifier. Use pathToFileURL(path).href (or new URL(relative, import.meta.url).href).',
      filePath: 'File URL .pathname is not a portable filesystem path (drive letters and percent escapes). Use fileURLToPath(url).',
    },
  },
  create(context) {
    const source = context.sourceCode;
    function variable(node) {
      let scope = source.getScope(node);
      while (scope) {
        if (scope.set.has(node.name)) return scope.set.get(node.name);
        scope = scope.upper;
      }
    }
    function definition(node) {
      if (node?.type !== 'Identifier') return;
      const binding = variable(node);
      if (binding?.defs.length !== 1) return;
      return binding.defs[0];
    }
    function unwrap(node, seen = new Set()) {
      if (node?.type !== 'Identifier' || seen.has(node)) return node;
      seen.add(node);
      const def = definition(node);
      const binding = variable(node);
      if (def?.type === 'Variable' && def.parent.kind === 'const' &&
          !binding.references.some(ref => ref.isWrite() && !ref.init)) {
        return unwrap(def.node.init, seen);
      }
      return node;
    }
    function imported(node, modules, names) {
      node = unwrap(node);
      if (node?.type === 'MemberExpression' && !node.computed) {
        const def = definition(node.object);
        return def?.type === 'ImportBinding' && modules.includes(def.parent.source.value) &&
          ['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(def.node.type) && names.includes(node.property.name);
      }
      const def = definition(node);
      return def?.type === 'ImportBinding' && modules.includes(def.parent.source.value) && names.includes(def.node.imported?.name);
    }
    function text(node) {
      node = unwrap(node);
      if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
      if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
    }
    function filesystem(node) {
      node = unwrap(node);
      const value = text(node);
      if (value !== undefined) return rawPath(value);
      return node?.type === 'CallExpression' &&
        (imported(node.callee, ['node:path', 'path'], ['join', 'resolve']) ||
         imported(node.callee, ['node:url', 'url'], ['fileURLToPath']));
    }
    // Only known file bases and literal references; no general URL data flow.
    function fileURL(node, seen = new Set()) {
      node = unwrap(node);
      if (!node || seen.has(node)) return false;
      seen.add(node);
      if (property(node) === 'url' && node.object.type === 'MetaProperty' &&
          node.object.meta.name === 'import' && node.object.property.name === 'meta') return true;
      if (node.type !== 'NewExpression') return false;
      const constructor = unwrap(node.callee);
      if (!(constructor?.type === 'Identifier' && constructor.name === 'URL' && !variable(constructor)?.defs.length) &&
          !imported(constructor, ['node:url', 'url'], ['URL'])) return false;
      const reference = text(node.arguments[0]);
      if (reference === undefined) return false;
      if (/^file:/i.test(reference)) return true;
      if (/^[a-z][a-z\d+.-]*:/i.test(reference)) return false;
      const base = text(node.arguments[1]);
      return base !== undefined ? /^file:/i.test(base) : fileURL(node.arguments[1], seen);
    }
    const report = node => context.report({ node, messageId: 'fileUrl' });
    function argumentsArray(node) {
      node = unwrap(node);
      if (node?.type !== 'ArrayExpression') return;
      for (let i = 0; i < node.elements.length; i++) {
        const element = node.elements[i];
        const value = text(element);
        // Stop at an unknown element or the entrypoint. Its following argv is not Node options.
        if (value === undefined || !value.startsWith('-') || value === '--') break;
        const match = value.match(flags);
        if (!match) continue;
        if (match[2] !== undefined) {
          if (rawPath(match[2])) report(element);
        } else {
          const specifier = node.elements[++i];
          if (filesystem(specifier)) report(specifier);
        }
      }
    }
    function nodeOptions(node) {
      const value = text(node);
      if (value !== undefined) {
        // Node's documented double-quoted NODE_OPTIONS form, not shell parsing.
        const tokens = value.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
        for (let i = 0; i < tokens.length; i++) {
          const match = tokens[i].match(flags);
          if (match && rawPath((match[2] ?? tokens[++i] ?? '').replace(/^"|"$/g, ''))) {
            report(node); return;
          }
        }
      }
      node = unwrap(node);
      if (node?.type === 'TemplateLiteral') {
        for (let i = 0; i < node.expressions.length; i++) {
          if (/(?:^|\s)--(?:import|loader|experimental-loader)(?:=|\s+)"?$/.test(node.quasis[i].value.cooked) && filesystem(node.expressions[i])) {
            report(node.expressions[i]);
          }
        }
      }
      if (node?.type === 'BinaryExpression' && node.operator === '+' &&
          /(?:^|\s)--(?:import|loader|experimental-loader)(?:=|\s+)"?$/.test(text(node.left) ?? '') && filesystem(node.right)) report(node.right);
    }
    return {
      MemberExpression(node) {
        if ((node.computed ? text(node.property) : node.property.name) === 'pathname' && fileURL(node.object)) {
          context.report({ node, messageId: 'filePath' });
        }
      },
      ImportExpression(node) { if (filesystem(node.source)) report(node.source); },
      CallExpression(node) {
        if (!imported(node.callee, ['node:child_process', 'child_process'], ['spawn', 'spawnSync', 'execFile', 'execFileSync'])) return;
        const executable = unwrap(node.arguments[0]);
        if ((property(executable) === 'execPath' && executable.object.name === 'process' && !variable(executable.object)?.defs.length) || ['node', 'node.exe'].includes(text(executable))) argumentsArray(node.arguments[1]);
      },
      Property(node) {
        if ((node.key.name ?? node.key.value) === 'NODE_OPTIONS' && !node.computed) nodeOptions(node.value);
      },
      AssignmentExpression(node) {
        if (property(node.left) === 'NODE_OPTIONS' && property(node.left.object) === 'env' && node.left.object.object.name === 'process' && !variable(node.left.object.object)?.defs.length) nodeOptions(node.right);
      },
    };
  },
};
