import type { AnalysisContext } from "../analyze";
import type { MethodInfo, PatternCheck, PatternMatch } from "../model";
import { parseTypeExpr, type TypeNode } from "../types";
import {
  allBodies, buildCreations, bodyCalls, bodyCreates, bodyMentions, callsOnField, check, concreteSubs, constructorIsHidden, createdTypes, ctors,
  elemType, isAbstraction, isCollectionField, isOwnType, makeMatch, methods, nameHas, publicMethods, returnsSelf, TYPE_CHECK, type PatternContext,
} from "./helpers";

const THREADED = new Set(["java", "kotlin", "csharp", "go"]);
const SUBCLASSABLE = new Set(["java", "kotlin", "csharp", "php"]);
const ACCESSOR = /^(get_?instance|instance|shared(_?instance)?|get_?shared|default|get_?default|current|get_?current|the|singleton|get)$/i;

// ---------------------------------------------------------------- Singleton
function singleton(ctx: PatternContext): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const t of ctx.types.nodes) {
    if (t.info.kind === "interface" || t.info.kind === "enum" || t.info.kind === "trait") continue;
    const isObject = t.info.kind === "object";
    if (isObject && t.info.methods.length + t.info.fields.length < 2) continue;
    const metaSingleton = t.info.decorators.some((d) => /^metaclass:.*singleton/i.test(d));
    const decorated = t.info.decorators.some((d) => /^singleton$/i.test(d));
    const instanceField = t.info.fields.find((f) => f.isStatic && (isOwnType(t, f.type) || bodyCreates(f.init ?? "", t.info.name, t.lang) || /^_*instance$/i.test(f.name)));
    const accessor = t.info.methods.find((m) => m.isStatic && m.kind !== "ctor" && (isOwnType(t, m.returns) || bodyCreates(m.body, t.info.name, t.lang) || /\b(new\s+(static|self)|cls\._|self::\$|static::\$)/.test(m.body)) && (ACCESSOR.test(m.name) || (instanceField && bodyMentions(m.body, instanceField.name))));
    const pyNew = t.lang === "python" ? t.info.methods.find((m) => m.name === "__new__" && /_instance|instances/.test(m.body)) : undefined;
    const named = nameHas(t, /singleton/i);
    if (!isObject && !metaSingleton && !decorated && !pyNew && !(instanceField && accessor) && !(named && (instanceField || accessor))) continue;

    const checks: PatternCheck[] = [];
    const byLanguage = isObject || metaSingleton || decorated;
    checks.push(check("required", byLanguage || !!instanceField || !!pyNew, "Holds its single instance", byLanguage ? "Guaranteed by the language/mechanism." : "A static field keeps the one shared instance."));
    checks.push(check("required", byLanguage || !!accessor || !!pyNew, "Global access point", "A static accessor (getInstance, Instance, shared…) returns the instance."));
    const hidden = byLanguage || constructorIsHidden(t);
    checks.push(check("required", hidden, "Constructor is closed", hidden ? "Nobody else can create a second instance." : "The constructor is public: `new` elsewhere silently creates a second instance."));
    if (THREADED.has(t.lang) && !isObject && accessor) {
      const body = accessor.body;
      const eager = !!instanceField && instanceField.isReadonly && bodyCreates(instanceField.init ?? "", t.info.name, t.lang);
      const safe = eager || accessor.flags.includes("synchronized") || /\b(synchronized|lock\s*\(|Lazy\s*<|by\s+lazy|once\.Do|LazyThreadSafetyMode|Interlocked|@Synchronized)/.test(body + " " + (instanceField?.init ?? "") + " " + (instanceField?.flags.join(" ") ?? "")) || /Lazy</.test(instanceField?.type ?? "");
      checks.push(check("recommended", safe, "Thread-safe initialisation", safe ? "Eager init, lock, Lazy<T> or double-checked locking." : "Lazy init without a lock: two threads can create two instances."));
    }
    if (SUBCLASSABLE.has(t.lang) && !isObject) {
      checks.push(check("recommended", t.info.isFinal, "Cannot be subclassed", t.info.isFinal ? "final/sealed prevents subclass instances." : "Not final/sealed: a subclass can create extra instances."));
    }
    const publicSetter = t.info.fields.some((f) => f.isStatic && f === instanceField && f.visibility === "public" && !f.isReadonly) || t.info.methods.some((m) => m.isStatic && /^set_?instance$/i.test(m.name));
    checks.push(check("anti", !publicSetter, "No way to replace the instance", publicSetter ? "A public setter/field lets anyone swap the instance." : undefined));
    const mutable = t.info.fields.filter((f) => !f.isStatic && f.visibility === "public" && !f.isReadonly && !f.flags.includes("property"));
    checks.push(check("anti", mutable.length === 0, "No public mutable state", mutable.length ? `Public mutable fields (${mutable.map((f) => f.name).slice(0, 3).join(", ")}) turn it into global mutable state.` : undefined));
    const confidence = byLanguage ? 0.7 : 0.6 + (named ? 0.2 : 0) + (accessor && ACCESSOR.test(accessor.name) ? 0.2 : 0);
    out.push(makeMatch(ctx, "singleton", `${t.id}`, { Singleton: [t] }, checks, confidence, `${t.info.name} keeps one shared instance${accessor ? ` behind ${accessor.name}()` : ""}.`));
  }
  // Module-level singletons: Go `var instance *T` + accessor, JS `export default new T()`.
  for (const f of ctx.files) {
    if (!f.source || (f.lang !== "go" && f.lang !== "typescript" && f.lang !== "javascript")) continue;
    for (const v of f.source.variables) {
      const typeName = parseTypeExpr(v.type)?.elem ?? [...createdTypes(v.init ?? "", f.lang)][0];
      if (!typeName) continue;
      const t = ctx.types.resolve(f.id, typeName);
      if (!t || t.info.kind === "interface") continue;
      const accessor = f.source.functions.find((fn) => bodyMentions(fn.body, v.name) && (parseTypeExpr(fn.returns)?.elem === typeName));
      // JS/TS: an exported instance of a class declared in the same module (`export default new X()`, `export const x = new X()`).
      const jsInstance = f.lang !== "go" && t.file === f.id && v.flags.includes("export") && bodyCreates(v.init ?? "", typeName, f.lang);
      if (f.lang === "go" && ctx.files[t.file].dir !== f.dir) continue;
      if (!(f.lang === "go" ? accessor && (/once\.Do|==\s*nil/.test(accessor.body)) : jsInstance)) continue;
      const checks: PatternCheck[] = [
        check("required", true, "Holds its single instance", `Package-level variable ${v.name}.`),
        check("required", f.lang !== "go" || !!accessor, "Global access point", accessor ? `${accessor.name}() returns it.` : "Exported module instance."),
        check("required", f.lang === "go" ? !t.info.isExported : !t.info.isExported, "Type cannot be constructed elsewhere", t.info.isExported ? `${t.info.name} is exported: other packages/modules can create their own.` : undefined),
      ];
      if (f.lang === "go" && accessor) checks.push(check("recommended", /once\.Do|sync\.Mutex|\.Lock\(\)/.test(accessor.body), "Thread-safe initialisation", "sync.Once (or a mutex) guards the lazy creation."));
      out.push(makeMatch(ctx, "singleton", `mod:${f.id}:${v.name}`, { Singleton: [t] }, checks, 0.65, `${f.name} exposes one shared ${t.info.name} instance (${v.name}).`));
    }
  }
  return out;
}

// ---------------------------------------------------------------- Factories
const CREATE_NAME = /^(create|make|build|new|get|from|of|for|produce|construct|instantiate)[A-Z_]?|^(create|make|build|produce|factory)$/i;

function factories(ctx: PatternContext): PatternMatch[] {
  const out: PatternMatch[] = [];
  const usedInAbstractFactory = new Set<number>();

  // Abstract Factory: an abstraction with ≥2 creation methods returning different products.
  for (const f of ctx.types.nodes) {
    if (!isAbstraction(ctx, f)) continue;
    const creators = f.info.methods.filter((m) => m.kind === "method" && CREATE_NAME.test(m.name) && m.returns && ctx.types.resolve(f.file, parseTypeExpr(m.returns)?.elem));
    const products = new Set(creators.map((m) => parseTypeExpr(m.returns)!.elem));
    if (creators.length < 2 || products.size < 2) continue;
    const impls = concreteSubs(ctx, f);
    if (!impls.length && !nameHas(f, /factory/i)) continue;
    usedInAbstractFactory.add(f.id);
    const productNodes = [...products].map((p) => ctx.types.resolve(f.file, p)).filter((x): x is TypeNode => !!x);
    const abstractProducts = productNodes.filter((p) => isAbstraction(ctx, p));
    const checks = [
      check("required", true, "Factory interface with several create methods", `${creators.map((c) => c.name).join(", ")}.`),
      check("required", impls.length >= 1, "Concrete factories implement it", impls.length ? `${impls.map((i) => i.info.name).join(", ")}.` : "No concrete factory found."),
      check("recommended", impls.length >= 2, "Several product families", impls.length >= 2 ? undefined : "Only one family: a plain factory would be simpler."),
      check("recommended", abstractProducts.length === productNodes.length, "Products are abstractions", abstractProducts.length === productNodes.length ? undefined : "Some create methods return concrete classes, so clients still depend on them."),
    ];
    out.push(makeMatch(ctx, "abstract-factory", `${f.id}`, { "Abstract factory": [f], "Concrete factory": impls, Product: productNodes }, checks, 0.6 + (nameHas(f, /factory/i) ? 0.3 : 0), `${f.info.name} creates a family of ${products.size} related products.`));
  }

  // Factory Method (GoF): abstract creator with an abstract method returning an abstraction, overridden by subclasses.
  for (const c of ctx.types.nodes) {
    if (!isAbstraction(ctx, c) || usedInAbstractFactory.has(c.id)) continue;
    const fm = c.info.methods.find((m) => m.isAbstract && CREATE_NAME.test(m.name) && isAbstraction(ctx, ctx.types.resolve(c.file, parseTypeExpr(m.returns)?.elem)));
    if (!fm) continue;
    const product = ctx.types.resolve(c.file, parseTypeExpr(fm.returns)!.elem)!;
    const creators = concreteSubs(ctx, c).filter((s) => s.info.methods.some((m) => m.name === fm.name && !m.isAbstract));
    const usesIt = c.info.methods.some((m) => !m.isAbstract && bodyCalls(m.body, fm.name));
    if (!creators.length) continue;
    const checks = [
      check("required", true, "Abstract creator declares the factory method", `${c.info.name}.${fm.name}() returns ${product.info.name}.`),
      check("required", creators.length > 0, "Subclasses override it", creators.map((s) => s.info.name).join(", ")),
      check("recommended", usesIt, "Creator uses the product through the abstraction", usesIt ? undefined : "No method of the creator calls the factory method: it is only a constructor wrapper."),
      check("recommended", concreteSubs(ctx, product).length >= 2, "Several concrete products", undefined),
    ];
    out.push(makeMatch(ctx, "factory-method", `${c.id}`, { Creator: [c], "Concrete creator": creators, Product: [product], "Concrete product": concreteSubs(ctx, product) }, checks, 0.75, `Subclasses of ${c.info.name} decide which ${product.info.name} to create.`));
  }

  // Simple factory: a method creating ≥2 product types sharing an abstraction (or any *Factory class).
  for (const t of ctx.types.nodes) {
    if (usedInAbstractFactory.has(t.id) || ctx.types.isInterfaceLike(t)) continue;
    const named = nameHas(t, /factory$/i);
    for (const m of methods(t)) {
      if (m.isAbstract || !(CREATE_NAME.test(m.name) || named)) continue;
      const created = [...createdTypes(m.body, t.lang)].map((n) => ctx.types.resolve(t.file, n)).filter((x): x is TypeNode => !!x && x.id !== t.id);
      const productBase = ctx.types.resolve(t.file, parseTypeExpr(m.returns)?.elem);
      const sharedBase = created.length >= 2 ? commonAbstraction(ctx, created) : undefined;
      if (!(created.length >= 2 && (sharedBase || isAbstraction(ctx, productBase))) && !(named && created.length >= 1)) continue;
      const base = isAbstraction(ctx, productBase) ? productBase : sharedBase;
      const products = dedupeNodes(created);
      const elsewhere = new Set<number>();
      for (const p of products) for (const fid of ctx.creations.get(p.info.name) ?? []) if (fid !== t.file && fid !== p.file && !ctx.files[fid].isTest) elsewhere.add(fid);
      const checks = [
        check("required", products.length >= 1, "Creates products", products.map((p) => p.info.name).join(", ")),
        check("recommended", !!base, "Returns an abstraction", base ? `Callers only see ${base.info.name}.` : "Returns a concrete class: callers stay coupled to it."),
        check("recommended", products.length >= 2, "Chooses between several products", products.length >= 2 ? undefined : "Creates a single type: this is a constructor wrapper."),
        check("recommended", /\b(default|else|throw|raise|panic|error|Error)\b/.test(m.body) || products.length < 2, "Handles unknown input", "No default/else/throw branch for unexpected kinds."),
        check("anti", elsewhere.size === 0, "Products are only created by the factory", elsewhere.size ? `${elsewhere.size} other file(s) still instantiate the products directly.` : undefined),
      ];
      out.push(makeMatch(ctx, "factory", `${t.id}:${m.name}`, { Factory: [t], Product: base ? [base] : [], "Concrete product": products }, checks, (named ? 0.5 : 0.35) + (products.length >= 2 ? 0.3 : 0) + (base ? 0.15 : 0), `${t.info.name}.${m.name}() creates ${products.map((p) => p.info.name).slice(0, 3).join(", ")}${products.length > 3 ? "…" : ""}.`));
      break; // one factory entry per class
    }
  }
  return out;
}

function commonAbstraction(ctx: PatternContext, nodes: TypeNode[]): TypeNode | undefined {
  const sets = nodes.map((n) => new Set(ctx.types.ancestors(n).filter((a) => isAbstraction(ctx, a)).map((a) => a.id)));
  const first = [...sets[0]];
  const common = first.find((id) => sets.every((s) => s.has(id)));
  return common === undefined ? undefined : ctx.types.nodes[common];
}

const dedupeNodes = (nodes: TypeNode[]) => [...new Map(nodes.map((n) => [n.id, n])).values()];

// ---------------------------------------------------------------- Builder
function builder(ctx: PatternContext): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const t of ctx.types.nodes) {
    if (ctx.types.isInterfaceLike(t)) continue;
    const FINAL = /^(build|create|get(Result|Product)?|make|to[A-Z]\w*|done|finish|construct)$/;
    const build = methods(t).find((m) => FINAL.test(m.name) && !returnsSelf(m, t));
    const steps = publicMethods(t).filter((m) => m.kind === "method" && !m.isStatic && m !== build && !FINAL.test(m.name));
    const fluent = steps.filter((m) => returnsSelf(m, t));
    const named = nameHas(t, /builder$/i);
    if (!(named && (steps.length >= 2 || build)) && !(fluent.length >= 3 && build)) continue;
    const productName = build ? parseTypeExpr(build.returns)?.elem ?? [...createdTypes(build.body, t.lang)][0] : undefined;
    const product = ctx.types.resolve(t.file, productName);
    // Director: another type holding the builder (or its interface) and calling several steps on it.
    const builderTypes = new Set([t.id, ...ctx.types.ancestors(t).map((a) => a.id)]);
    const stepNames = new Set(steps.map((m) => m.name));
    const holds = (d: TypeNode, type: string | undefined) => builderTypes.has(ctx.types.resolve(d.file, parseTypeExpr(type)?.elem)?.id ?? -1);
    const directors = ctx.types.nodes.filter((d) => d.id !== t.id && !builderTypes.has(d.id) && d.info.methods.some((m) => {
      const handles = [...d.info.fields.filter((f) => holds(d, f.type)).map((f) => f.name), ...m.params.filter((p) => holds(d, p.type)).map((p) => p.name)];
      return handles.some((name) => [...callsOnField(m.body, name)].filter((c) => stepNames.has(c)).length >= 2);
    }));
    const checks: PatternCheck[] = [
      check("required", steps.length >= 2, "Step-by-step construction", steps.length ? `${steps.slice(0, 5).map((m) => m.name).join(", ")}${steps.length > 5 ? "…" : ""}` : "No step methods to configure the object."),
      check("required", !!build, "Final build method", build ? `${build.name}() produces ${product?.info.name ?? productName ?? "the result"}.` : "No build()/getResult() method producing the object."),
      check("recommended", fluent.length >= 2 || directors.length > 0, "Chainable steps or a Director", fluent.length >= 2 ? "Steps return the builder: calls chain fluently." : directors.length ? `${directors.map((d) => d.info.name).join(", ")} drives the steps.` : "Steps neither chain nor are driven by a Director: callers orchestrate every step."),
    ];
    if (build) checks.push(check("recommended", /\b(throw|raise|require|check|assert|Objects\.requireNonNull|ArgumentNullException|if)\b/.test(build.body), "Validates before building", "build() doesn't check mandatory parts: invalid objects can be produced."));
    if (product) {
      const setters = product.info.methods.filter((m) => /^set[A-Z_]/.test(m.name) && m.visibility === "public").length + product.info.fields.filter((f) => !f.isStatic && f.visibility === "public" && !f.isReadonly && (!f.flags.includes("property") || f.flags.includes("setter"))).length;
      checks.push(check("recommended", setters === 0, "Built object is immutable", setters ? `${product.info.name} still has ${setters} public setter(s)/field(s): the builder is optional.` : undefined));
      checks.push(check("recommended", constructorIsHidden(product) || product.info.methods.filter((m) => m.kind === "ctor").length === 0 ? true : product.info.methods.some((m) => m.kind === "ctor" && m.visibility !== "public"), "Product is created through the builder", "The product's constructor is public, so the builder can be bypassed."));
    }
    const exposed = t.info.fields.filter((f) => !f.isStatic && f.visibility === "public" && !f.isReadonly && !f.flags.includes("promoted"));
    checks.push(check("anti", exposed.length === 0, "No public mutable fields on the builder", exposed.length ? `${exposed.map((f) => f.name).slice(0, 3).join(", ")} can be set without the fluent API.` : undefined));
    out.push(makeMatch(ctx, "builder", `${t.id}`, { Builder: [t], Director: directors, Product: product ? [product] : [] }, checks, (named ? 0.6 : 0.4) + (fluent.length >= 3 || directors.length ? 0.3 : 0.1), `${t.info.name} builds ${product?.info.name ?? productName ?? "an object"} step by step.`));
  }
  return out;
}

// ---------------------------------------------------------------- Observer
const LISTENER_NAME = /(listener|observer|subscriber|handler|callback|watcher|sink|hook|subscription|cb)s?$/i;
const SUBSCRIBE = /^(add\w*(listener|observer|handler|callback|subscriber)|subscribe|attach|register|on|listen|watch|addEventListener|add)$/i;
const UNSUBSCRIBE = /^(remove\w*(listener|observer|handler|callback|subscriber)?|unsubscribe|detach|unregister|off|unlisten|unwatch|removeEventListener|delete|clear\w*)$/i;

function observer(ctx: PatternContext): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const t of ctx.types.nodes) {
    if (ctx.types.isInterfaceLike(t)) continue;
    // C#: `event` fields are the language's observer.
    const events = t.info.fields.filter((f) => f.flags.includes("event"));
    const listField = t.info.fields.find((f) => isCollectionField(f) && (LISTENER_NAME.test(f.name) || isListenerType(ctx, t, elemType(f))));
    if (!listField && !events.length) continue;
    if (events.length && !listField) {
      const raised = events.filter((e) => t.info.methods.some((m) => new RegExp(`\\b${e.name}\\s*(\\?\\.\\s*Invoke|\\()`).test(m.body)));
      const checks = [
        check("required", true, "Subject publishes events", events.map((e) => e.name).join(", ")),
        check("required", raised.length > 0, "Events are raised", raised.length ? undefined : "Events are declared but never invoked."),
        check("recommended", events.every((e) => /EventHandler/.test(e.type ?? "")), "Standard EventHandler signature", "Custom delegate types make subscribers harder to write."),
      ];
      out.push(makeMatch(ctx, "observer", `${t.id}`, { Subject: [t] }, checks, 0.7, `${t.info.name} notifies subscribers through C# events.`));
      continue;
    }
    const field = listField!;
    const touches = (m: MethodInfo) => bodyMentions(m.body, field.name);
    const subscribe = methods(t).find((m) => touches(m) && (SUBSCRIBE.test(m.name) || /\.(add|push|append|Add|insert|set)\s*\(|\+=|\[\]\s*=|\.put\(/.test(m.body)) && m.params.length >= 1);
    const unsubscribe = methods(t).find((m) => touches(m) && (UNSUBSCRIBE.test(m.name) || /\.(remove|Remove|splice|delete|discard|filter)\s*\(|-=/.test(m.body)) && m !== subscribe);
    const returnsDisposer = subscribe && /\breturn\s*(\(\)\s*=>|function|lambda|func\(|\{\s*dispose|new\s+\w*(Subscription|Disposable))/.test(subscribe.body);
    const notify = methods(t).find((m) => m !== subscribe && m !== unsubscribe && touches(m) && /\b(for|forEach|each|map|foreach)\b/.test(m.body));
    if (!subscribe || !notify) continue;
    const elemNode = ctx.types.resolve(t.file, elemType(field));
    const fnTyped = /=>|Function|Callable|Action<|Consumer<|Runnable|func\(|\(\)\s*->/.test(field.type ?? "");
    const observers = elemNode ? concreteSubs(ctx, elemNode) : [];
    const checks = [
      check("required", true, "Keeps a list of observers", `${field.name}${field.type ? ": " + field.type : ""}`),
      check("required", true, "Subscribe method", `${subscribe.name}()`),
      check("required", true, "Notifies every observer", `${notify.name}() loops over ${field.name}.`),
      check("recommended", !!unsubscribe || !!returnsDisposer, "Observers can unsubscribe", unsubscribe ? `${unsubscribe.name}()` : returnsDisposer ? "subscribe returns a disposer." : "No way to unsubscribe: observers leak and keep receiving events."),
      check("recommended", fnTyped || isAbstraction(ctx, elemNode) || !elemNode, "Observers are an abstraction", elemNode && !isAbstraction(ctx, elemNode) ? `The subject depends on the concrete class ${elemNode.info.name}.` : undefined),
      check("anti", !(field.visibility === "public" && !field.isReadonly), "Observer list is private", field.visibility === "public" ? "The list is public: anyone can clear or replace observers." : undefined),
    ];
    out.push(makeMatch(ctx, "observer", `${t.id}`, { Subject: [t], Observer: elemNode ? [elemNode] : [], "Concrete observer": observers }, checks, 0.55 + (LISTENER_NAME.test(field.name) ? 0.2 : 0) + (SUBSCRIBE.test(subscribe.name) ? 0.15 : 0), `${t.info.name} notifies its ${field.name} when something happens.`));
  }
  return out;
}

function isListenerType(ctx: PatternContext, from: TypeNode, name: string | undefined): boolean {
  if (!name) return false;
  if (LISTENER_NAME.test(name)) return true;
  const n = ctx.types.resolve(from.file, name);
  return !!n && ctx.types.isInterfaceLike(n) && /^(on|update|notify|handle)/i.test(n.info.methods[0]?.name ?? "");
}

// ---------------------------------------------------------------- Strategy / State
function strategyAndState(ctx: PatternContext): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const s of ctx.types.nodes) {
    if (!isAbstraction(ctx, s) || s.info.methods.length === 0) continue;
    const impls = concreteSubs(ctx, s);
    if (impls.length < 2) continue;
    const isStateLike = /state$/i.test(s.info.name);
    // Contexts: types (not implementations) holding a single reference typed by the abstraction and calling it.
    for (const c of ctx.types.nodes) {
      if (c.id === s.id || impls.includes(c) || ctx.types.ancestors(c).includes(s)) continue;
      const field = c.info.fields.find((f) => !isCollectionField(f) && ctx.types.resolve(c.file, elemType(f)) === s);
      if (!field) continue;
      const delegated = new Set<string>();
      for (const m of c.info.methods) for (const name of callsOnField(m.body, field.name)) delegated.add(name);
      const sMethods = new Set(s.info.methods.map((m) => m.name));
      if (![...delegated].some((d) => sMethods.has(d))) continue;
      const state = isStateLike || /state/i.test(field.name);
      const injected = c.info.methods.some((m) => (m.kind === "ctor" || /^set/i.test(m.name) || m.kind === "setter") && m.params.some((p) => ctx.types.resolve(c.file, parseTypeExpr(p.type)?.elem) === s)) || field.flags.includes("promoted");
      const hardWired = impls.filter((i) => bodyCreates(allBodies(c) + " " + (field.init ?? ""), i.info.name, c.lang));
      const typeChecks = impls.filter((i) => TYPE_CHECK(i.info.name).test(allBodies(c)));
      if (state) {
        const transitionsInStates = impls.filter((i) => i.info.methods.some((m) => /\b(setState|set_state|transitionTo|transition_to|changeState|change_state)\s*\(|\.state\s*=|\.State\s*=/.test(m.body) || impls.some((o) => o !== i && bodyCreates(m.body, o.info.name, i.lang))));
        const transitionsInContext = /\b(switch|when|match)\b/.test(allBodies(c)) || hardWired.length > 0;
        const checks = [
          check("required", true, "State interface with several states", `${s.info.name}: ${impls.map((i) => i.info.name).slice(0, 5).join(", ")}${impls.length > 5 ? "…" : ""}`),
          check("required", true, "Context delegates to its current state", `${c.info.name}.${field.name} → ${[...delegated].filter((d) => sMethods.has(d)).join(", ")}()`),
          check("recommended", transitionsInStates.length > 0 || transitionsInContext, "Transitions are defined", transitionsInStates.length ? `${transitionsInStates.length} state(s) trigger transitions.` : transitionsInContext ? "Transitions are driven by the context." : "No transition found: the state never changes."),
          check("recommended", !(field.visibility === "public" && !field.isReadonly), "Current state is encapsulated", "The state field is public: anyone can jump to any state."),
          check("anti", typeChecks.length === 0, "No type checks on states", typeChecks.length ? `The context tests concrete states (${typeChecks.map((i) => i.info.name).join(", ")}), defeating polymorphism.` : undefined),
        ];
        out.push(makeMatch(ctx, "state", `${s.id}:${c.id}`, { Context: [c], State: [s], "Concrete state": impls }, checks, 0.6 + (isStateLike ? 0.3 : 0.1), `${c.info.name} changes behaviour with its ${s.info.name}.`));
      } else {
        const named = /(strategy|policy|algorithm|provider|handler|rule)$/i.test(s.info.name);
        const checks = [
          check("required", true, "Strategy interface with several implementations", `${s.info.name}: ${impls.map((i) => i.info.name).slice(0, 5).join(", ")}${impls.length > 5 ? "…" : ""}`),
          check("required", true, "Context delegates to the strategy", `${c.info.name}.${field.name} → ${[...delegated].filter((d) => sMethods.has(d)).join(", ")}()`),
          check("recommended", injected, "Strategy is injected", injected ? "Passed through the constructor or a setter." : "The context chooses its strategy itself: it can't be swapped from outside."),
          check("anti", hardWired.length === 0, "Context doesn't instantiate concrete strategies", hardWired.length ? `${c.info.name} creates ${hardWired.map((i) => i.info.name).join(", ")} itself (hard-wired).` : undefined),
          check("anti", typeChecks.length === 0, "No type checks on strategies", typeChecks.length ? `${c.info.name} tests concrete strategies (${typeChecks.map((i) => i.info.name).join(", ")}).` : undefined),
        ];
        out.push(makeMatch(ctx, "strategy", `${s.id}:${c.id}`, { Context: [c], Strategy: [s], "Concrete strategy": impls }, checks, 0.55 + (named ? 0.3 : 0) + (injected ? 0.1 : 0), `${c.info.name} delegates to interchangeable ${s.info.name} implementations.`));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- Decorator / Proxy / Adapter / Composite
function wrappers(ctx: PatternContext): PatternMatch[] {
  const out: PatternMatch[] = [];
  const decoratorsByComponent = new Map<number, TypeNode[]>();
  const pending: { comp: TypeNode; t: TypeNode; build: (hasBase: boolean) => PatternMatch }[] = [];
  for (const t of ctx.types.nodes) {
    if (ctx.types.isInterfaceLike(t)) continue;
    const supers = ctx.types.ancestors(t).filter((a) => isAbstraction(ctx, a) || a.subs.length > 1);
    const superIds = new Set(supers.map((a) => a.id));

    // Composite: a collection of the component type + operation forwarded to children.
    const childrenField = t.info.fields.find((f) => isCollectionField(f) && superIds.has(ctx.types.resolve(t.file, elemType(f))?.id ?? -1));
    if (childrenField) {
      const comp = ctx.types.resolve(t.file, elemType(childrenField))!;
      const compMethods = new Set(comp.info.methods.map((m) => m.name));
      const forwarded = t.info.methods.filter((m) => compMethods.has(m.name) && /\b(for|forEach|map|sum|reduce|each|foreach|all|any)\b/.test(m.body) && bodyMentions(m.body, childrenField.name));
      if (forwarded.length) {
        const add = t.info.methods.find((m) => /^(add|append|push|insert|attach)\w*/i.test(m.name));
        const remove = t.info.methods.find((m) => /^(remove|delete|detach|pop)\w*/i.test(m.name));
        const leaves = concreteSubs(ctx, comp).filter((l) => l.id !== t.id && !l.info.fields.some((f) => isCollectionField(f) && ctx.types.resolve(l.file, elemType(f)) === comp));
        const checks = [
          check("required", true, "Shares the component interface", `${t.info.name} is a ${comp.info.name}.`),
          check("required", true, "Holds children typed by the component", `${childrenField.name}: ${childrenField.type ?? "collection"}`),
          check("required", true, "Forwards operations to children", forwarded.map((m) => m.name + "()").join(", ")),
          check("recommended", !!add && !!remove, "Child management", add && remove ? `${add.name}() / ${remove.name}()` : `Missing ${add ? "" : "add"}${!add && !remove ? " and " : ""}${remove ? "" : "remove"} methods.`),
          check("recommended", leaves.length > 0, "Leaf types exist", leaves.length ? leaves.map((l) => l.info.name).slice(0, 4).join(", ") : "No leaf implementation of the component found."),
          check("recommended", isAbstraction(ctx, comp), "Component is an abstraction", isAbstraction(ctx, comp) ? undefined : `${comp.info.name} is concrete: leaves inherit unused child-management code.`),
        ];
        out.push(makeMatch(ctx, "composite", `${t.id}`, { Composite: [t], Component: [comp], Leaf: leaves }, checks, 0.75, `${t.info.name} treats a tree of ${comp.info.name} objects like a single one.`));
        continue;
      }
    }

    // Single wrapped reference.
    const wrapField = t.info.fields.find((f) => !f.isStatic && !isCollectionField(f) && !/^_?(next|successor)/i.test(f.name) && f.type && ctx.types.resolve(t.file, elemType(f)) && ctx.types.resolve(t.file, elemType(f))!.id !== t.id);
    if (!wrapField) continue;
    const wrapped = ctx.types.resolve(t.file, elemType(wrapField))!;
    const delegated = new Map<string, string[]>();
    for (const m of methods(t)) {
      const called = [...callsOnField(m.body, wrapField.name)];
      if (called.length) delegated.set(m.name, called);
    }
    if (!delegated.size) continue;
    const sameInterface = superIds.has(wrapped.id) || supers.some((s) => ctx.types.ancestors(wrapped).includes(s));
    const injected = ctors(t).some((c) => c.params.some((p) => ctx.types.resolve(t.file, parseTypeExpr(p.type)?.elem)?.id === wrapped.id)) || wrapField.flags.includes("promoted") || (t.lang === "python" && /^[a-z_]\w*$/.test((wrapField.init ?? "").trim()));
    const createsWrapped = bodyCreates(allBodies(t) + " " + (wrapField.init ?? ""), wrapped.info.name, t.lang) || concreteSubs(ctx, wrapped).some((c) => bodyCreates(allBodies(t), c.info.name, t.lang));

    if (sameInterface) {
      const proxy = nameHas(t, /proxy$/i) || (createsWrapped && !injected);
      const comp = supers.find((s) => s.id === wrapped.id || ctx.types.ancestors(wrapped).includes(s)) ?? wrapped;
      const forwardsSame = [...delegated.entries()].filter(([name, called]) => called.includes(name));
      if (proxy) {
        const guarded = [...delegated.keys()].some((name) => /\b(if|when|cache|lazy|check|authorize|allowed|log|throw|raise)\b/i.test(t.info.methods.find((m) => m.name === name)?.body ?? ""));
        const checks = [
          check("required", true, "Same interface as the real subject", `${t.info.name} and ${wrapped.info.name} share ${comp.info.name}.`),
          check("required", forwardsSame.length > 0, "Forwards to the real subject", forwardsSame.map(([n]) => n + "()").join(", ") || "Calls don't reach the subject's same methods."),
          check("recommended", guarded, "Adds control (lazy, cache, access…)", guarded ? undefined : "Pure pass-through: the proxy adds nothing."),
          check("anti", !(wrapField.visibility === "public"), "Real subject is hidden", wrapField.visibility === "public" ? "The real subject is public: clients can bypass the proxy." : undefined),
        ];
        out.push(makeMatch(ctx, "proxy", `${t.id}`, { Proxy: [t], Subject: [comp], "Real subject": [wrapped] }, checks, 0.5 + (nameHas(t, /proxy$/i) ? 0.4 : 0), `${t.info.name} stands in for ${wrapped.info.name}.`));
        continue;
      }
      if (forwardsSame.length === 0) continue;
      const build = (hasBase: boolean) => {
        const checks = [
          check("required", true, "Same interface as the wrapped object", `${t.info.name} is a ${comp.info.name}.`),
          check("required", injected, "Wraps an object received from outside", injected ? `${wrapField.name} comes from the constructor.` : "The wrapped object isn't injected."),
          check("required", true, "Forwards calls", forwardsSame.map(([n]) => n + "()").slice(0, 4).join(", ")),
          check("recommended", hasBase, "Shared decorator base", hasBase ? undefined : "Several decorators repeat the delegation code: extract an abstract decorator."),
          check("anti", !createsWrapped, "Doesn't create what it decorates", createsWrapped ? `${t.info.name} instantiates the wrapped object itself, so it can't be stacked.` : undefined),
        ];
        return makeMatch(ctx, "decorator", `${t.id}`, { Decorator: [t], Component: [comp], Wrapped: [wrapped] }, checks, 0.55 + (nameHas(t, /(decorator|wrapper)$/i) ? 0.35 : 0.15), `${t.info.name} adds behaviour around any ${comp.info.name}.`);
      };
      const list = decoratorsByComponent.get(comp.id) ?? [];
      list.push(t);
      decoratorsByComponent.set(comp.id, list);
      pending.push({ comp, t, build });
      continue;
    }

    // Adapter: implements a target, wraps an unrelated adaptee, translates calls.
    const targets = supers.filter((s) => isAbstraction(ctx, s));
    if (!targets.length || wrapped.info.kind === "enum") continue;
    const target = targets[0];
    const targetMethods = new Set(target.info.methods.map((m) => m.name));
    const translated = [...delegated.entries()].filter(([name]) => targetMethods.has(name));
    const named = nameHas(t, /adapter$/i);
    // Without the name, an adapter is structurally indistinguishable from a command/strategy wrapping a receiver.
    if (!named) continue;
    const heavy = t.info.methods.filter((m) => m.loc > 40);
    const checks = [
      check("required", true, "Implements the target interface", `${t.info.name} → ${target.info.name}`),
      check("required", true, "Wraps an adaptee of another type", `${wrapField.name}: ${wrapped.info.name}`),
      check("required", translated.length > 0, "Translates calls", translated.map(([n, c]) => `${n}() → ${c[0]}()`).slice(0, 3).join(", ") || "Target methods don't call the adaptee."),
      check("recommended", injected, "Adaptee is injected", injected ? undefined : "The adapter creates its adaptee, making it hard to test or reuse."),
      check("anti", heavy.length === 0, "No business logic inside", heavy.length ? `${heavy.map((m) => m.name).join(", ")} exceed 40 lines: the adapter does more than translate.` : undefined),
    ];
    out.push(makeMatch(ctx, "adapter", `${t.id}`, { Adapter: [t], Target: [target], Adaptee: [wrapped] }, checks, 0.5 + (named ? 0.4 : 0.1), `${t.info.name} lets ${wrapped.info.name} be used as a ${target.info.name}.`));
  }
  for (const { comp, t, build } of pending) {
    const siblings = decoratorsByComponent.get(comp.id) ?? [];
    const hasBase = siblings.length < 2 || t.parents.some((p) => ctx.types.nodes[p].info.isAbstract && ctx.types.ancestors(ctx.types.nodes[p]).includes(comp));
    out.push(build(hasBase));
  }
  return out;
}

// ---------------------------------------------------------------- Command
const EXECUTE = /^(execute|run|handle|call|invoke|perform|apply|do|exec|process|__call__)$/i;

function command(ctx: PatternContext): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const c of ctx.types.nodes) {
    if (!isAbstraction(ctx, c)) continue;
    const ops = c.info.methods.filter((m) => m.kind === "method");
    const exec = ops.find((m) => EXECUTE.test(m.name));
    if (!exec || ops.length > 3) continue;
    const named = /command$/i.test(c.info.name);
    if (!named && ops.length > 2) continue;
    const impls = concreteSubs(ctx, c);
    if (impls.length < 2) continue;
    if (!named && !/^(execute|undo)$/i.test(exec.name)) continue; // generic run()/handle() interfaces are too common
    const invokers = ctx.types.nodes.filter((n) => n.id !== c.id && !impls.includes(n) && n.info.fields.some((f) => ctx.types.resolve(n.file, elemType(f)) === c) && n.info.methods.some((m) => new RegExp(`\\.${exec.name}\\s*\\(`).test(m.body)));
    const undo = ops.some((m) => /^(undo|revert|rollback|unexecute)$/i.test(m.name));
    const fat = impls.filter((i) => i.info.fields.length === 0 && (i.info.methods.find((m) => m.name === exec.name)?.loc ?? 0) > 20);
    const checks = [
      check("required", true, "Command interface", `${c.info.name}.${exec.name}()`),
      check("required", true, "Several concrete commands", impls.map((i) => i.info.name).slice(0, 5).join(", ")),
      check("recommended", invokers.length > 0, "An invoker stores and triggers commands", invokers.length ? invokers.map((i) => i.info.name).join(", ") : "No invoker found: commands are called directly, losing queueing/history."),
      check("recommended", undo, "Undo support", undo ? undefined : "No undo/revert method (optional, but a classic reason to use commands)."),
      check("anti", fat.length === 0, "Commands delegate to receivers", fat.length ? `${fat.map((i) => i.info.name).slice(0, 3).join(", ")} hold all the logic themselves instead of calling a receiver.` : undefined),
    ];
    out.push(makeMatch(ctx, "command", `${c.id}`, { Command: [c], "Concrete command": impls, Invoker: invokers }, checks, 0.5 + (named ? 0.4 : 0.15), `Requests are objects implementing ${c.info.name}.`));
  }
  return out;
}

// ---------------------------------------------------------------- Template Method
function templateMethod(ctx: PatternContext): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const b of ctx.types.nodes) {
    if (!b.info.isAbstract || ctx.types.isInterfaceLike(b)) continue;
    const abstractSteps = b.info.methods.filter((m) => m.isAbstract);
    if (abstractSteps.length < 1) continue;
    const template = b.info.methods.find((m) => !m.isAbstract && m.kind === "method" && abstractSteps.filter((s) => bodyCalls(m.body, s.name)).length >= Math.min(2, abstractSteps.length));
    if (!template) continue;
    const subs = concreteSubs(ctx, b);
    if (!subs.length) continue;
    const steps = abstractSteps.filter((s) => bodyCalls(template.body, s.name));
    const overriding = subs.filter((s) => s.info.methods.some((m) => m.name === template.name));
    const finalTemplate = template.flags.includes("final") || (b.lang === "csharp" && !template.flags.includes("virtual")) || (b.lang === "kotlin" && !template.flags.includes("open"));
    const publicSteps = steps.filter((s) => s.visibility === "public");
    const checks = [
      check("required", true, "Abstract base defines the skeleton", `${b.info.name}.${template.name}()`),
      check("required", true, "Steps are abstract", steps.map((s) => s.name + "()").join(", ")),
      check("required", true, "Subclasses fill in the steps", subs.map((s) => s.info.name).slice(0, 5).join(", ")),
    ];
    if (SUBCLASSABLE.has(b.lang)) checks.push(check("recommended", finalTemplate, "Template can't be overridden", finalTemplate ? undefined : "The template method is overridable: subclasses can break the algorithm order."));
    checks.push(check("recommended", publicSteps.length === 0, "Steps are protected", publicSteps.length ? `${publicSteps.map((s) => s.name).join(", ")} are public: clients can call steps out of order.` : undefined));
    checks.push(check("anti", overriding.length === 0, "Subclasses don't redefine the skeleton", overriding.length ? `${overriding.map((s) => s.info.name).join(", ")} override ${template.name}() itself.` : undefined));
    out.push(makeMatch(ctx, "template-method", `${b.id}`, { "Abstract class": [b], "Concrete class": subs }, checks, 0.75, `${b.info.name}.${template.name}() fixes the steps, subclasses implement them.`));
  }
  return out;
}

// ---------------------------------------------------------------- Chain of Responsibility
function chain(ctx: PatternContext): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const t of ctx.types.nodes) {
    if (ctx.types.isInterfaceLike(t)) continue;
    const ancestors = ctx.types.ancestors(t);
    const nextField = t.info.fields.find((f) => /^(_?next|successor|_?nextHandler|next_handler|_next)$/i.test(f.name) && (() => { const n = ctx.types.resolve(t.file, elemType(f)); return !!n && (n.id === t.id || ancestors.includes(n)); })());
    if (!nextField) continue;
    const handler = ctx.types.resolve(t.file, elemType(nextField))!;
    const passes = t.info.methods.find((m) => callsOnField(m.body, nextField.name).size > 0);
    if (!passes) continue;
    const handlers = concreteSubs(ctx, handler.id === t.id ? t : handler);
    const conditional = /\b(if|when|switch|match|canHandle|can_handle)\b/.test(passes.body);
    const checks = [
      check("required", true, "Handlers link to the next one", `${t.info.name}.${nextField.name}`),
      check("required", true, "Requests are passed along", `${passes.name}() calls ${nextField.name}.`),
      check("recommended", handlers.length >= 2, "Several concrete handlers", handlers.length ? handlers.map((h) => h.info.name).slice(0, 5).join(", ") : "Only one handler: no chain to speak of."),
      check("recommended", isAbstraction(ctx, handler) || t.info.isAbstract, "Handlers share an abstraction", undefined),
      check("anti", conditional, "Each handler decides whether to pass on", conditional ? undefined : "The request is always forwarded unconditionally: it's a pipeline, not a chain."),
    ];
    out.push(makeMatch(ctx, "chain", `${t.id}`, { Handler: [handler.id === t.id ? t : handler], "Concrete handler": handlers.length ? handlers : [t] }, checks, 0.75, `${t.info.name} passes requests to the next handler.`));
  }
  return out;
}

// ---------------------------------------------------------------- Visitor
function visitor(ctx: PatternContext): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const v of ctx.types.nodes) {
    if (!isAbstraction(ctx, v)) continue;
    const visits = v.info.methods.filter((m) => /^visit/i.test(m.name));
    if (visits.length < 2) continue;
    const elements = ctx.types.nodes.filter((e) => e.info.methods.some((m) => /^accept$/i.test(m.name) && m.params.some((p) => ctx.types.resolve(e.file, parseTypeExpr(p.type)?.elem) === v || /visitor/i.test(p.name))));
    if (!elements.length) continue;
    const concreteElements = elements.filter((e) => !isAbstraction(ctx, e));
    const doubleDispatch = concreteElements.filter((e) => /\.\s*visit\w*\s*\(\s*(this|self|\$this)/.test(e.info.methods.find((m) => /^accept$/i.test(m.name))?.body ?? ""));
    const visitTargets = new Set(visits.map((m) => m.name.replace(/^visit_?/i, "").toLowerCase()).concat(visits.map((m) => parseTypeExpr(m.params[0]?.type)?.elem?.toLowerCase() ?? "")));
    const missing = concreteElements.filter((e) => !visitTargets.has(e.info.name.toLowerCase()));
    const visitors = concreteSubs(ctx, v);
    const typeChecks = visitors.filter((x) => /\b(instanceof|isinstance)\b|\bis\s+[A-Z]/.test(allBodies(x)));
    const checks = [
      check("required", true, "Visitor interface with one visit per element", visits.map((m) => m.name).slice(0, 5).join(", ")),
      check("required", elements.length > 0, "Elements accept a visitor", concreteElements.map((e) => e.info.name).slice(0, 5).join(", ")),
      check("required", doubleDispatch.length > 0, "Double dispatch", doubleDispatch.length ? "accept() calls visitor.visitX(this)." : "accept() doesn't call back the visitor with itself."),
      check("recommended", missing.length === 0, "Every element has a visit method", missing.length ? `No visit method for ${missing.map((e) => e.info.name).slice(0, 4).join(", ")}.` : undefined),
      check("recommended", visitors.length >= 1, "Concrete visitors exist", visitors.length ? visitors.map((x) => x.info.name).slice(0, 4).join(", ") : "No concrete visitor found."),
      check("anti", typeChecks.length === 0, "No type checks in visitors", typeChecks.length ? `${typeChecks.map((x) => x.info.name).join(", ")} switch on types, which the pattern exists to avoid.` : undefined),
    ];
    out.push(makeMatch(ctx, "visitor", `${v.id}`, { Visitor: [v], "Concrete visitor": visitors, Element: concreteElements }, checks, 0.85, `Operations over ${concreteElements.length} element types live in ${v.info.name} implementations.`));
  }
  return out;
}

// ---------------------------------------------------------------- Facade
function facade(ctx: PatternContext): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const t of ctx.types.nodes) {
    if (!nameHas(t, /facade$/i) || ctx.types.isInterfaceLike(t)) continue;
    const subsystems = dedupeNodes(t.info.fields.map((f) => ctx.types.resolve(t.file, elemType(f))).filter((x): x is TypeNode => !!x && x.id !== t.id));
    const pub = publicMethods(t);
    const exposed = t.info.fields.filter((f) => f.visibility === "public" && subsystems.some((s) => s.info.name === elemType(f))).concat(pub.filter((m) => subsystems.some((s) => s.info.name === parseTypeExpr(m.returns)?.elem)).map((m) => ({ name: m.name }) as never));
    const facadeFile = t.file;
    const subsystemFiles = new Set(subsystems.map((s) => s.file));
    const clients = ctx.edges.filter((e) => e.to === facadeFile).map((e) => e.from);
    const bypass = clients.filter((c) => ctx.adj[c].some((d) => subsystemFiles.has(d)));
    const checks = [
      check("required", subsystems.length >= 2, "Wraps several subsystem objects", subsystems.length ? subsystems.map((s) => s.info.name).slice(0, 5).join(", ") : "No subsystem objects held."),
      check("required", pub.length >= 1, "Offers a simple API", `${pub.length} public method(s).`),
      check("recommended", bypass.length === 0, "Clients go through the facade", bypass.length ? `${bypass.length} client file(s) also use the subsystems directly.` : undefined),
      check("anti", exposed.length === 0, "Subsystems stay hidden", exposed.length ? "The facade hands out its subsystem objects." : undefined),
    ];
    out.push(makeMatch(ctx, "facade", `${t.id}`, { Facade: [t], Subsystem: subsystems }, checks, 0.8, `${t.info.name} is the single entry point to ${subsystems.length} subsystem part(s).`));
  }
  return out;
}

// ---------------------------------------------------------------- Repository
const FRAMEWORK_REPO = /^(CrudRepository|JpaRepository|MongoRepository|PagingAndSortingRepository|ReactiveCrudRepository|ReactiveMongoRepository|ListCrudRepository|CoroutineCrudRepository|Repository|IRepository|DbSet|DbContext|EntityRepository|BaseRepository|Model)$/;
const CRUD = /^(find|get|fetch|load|read|list|all|query|search|count|exists|save|store|persist|insert|add|create|update|upsert|put|delete|remove|destroy)/i;

function repository(ctx: PatternContext): PatternMatch[] {
  const out: PatternMatch[] = [];
  const handled = new Set<number>();
  for (const t of ctx.types.nodes) {
    if (!nameHas(t, /(repository|repo|dao)$/i) || handled.has(t.id)) continue;
    const isAbs = isAbstraction(ctx, t);
    const impls = isAbs ? concreteSubs(ctx, t) : [];
    const abstraction = isAbs ? t : ctx.types.ancestors(t).find((a) => isAbstraction(ctx, a) && /(repository|repo|dao)$/i.test(a.info.name));
    if (!isAbs && abstraction && concreteSubs(ctx, abstraction).includes(t)) continue; // reported through its interface
    handled.add(t.id);
    for (const i of impls) handled.add(i.id);
    const ops = publicMethods(t).filter((m) => m.kind === "method");
    const crud = ops.filter((m) => CRUD.test(m.name));
    const verbs = new Set(crud.map((m) => (CRUD.exec(m.name)?.[1] ?? "").toLowerCase()));
    const business = ops.filter((m) => !CRUD.test(m.name));
    // Framework repositories (Spring Data, EF, TypeORM…) inherit their CRUD operations.
    const frameworkBase = [...t.info.extends, ...t.info.implements].find((n) => FRAMEWORK_REPO.test(n) && !ctx.types.resolve(t.file, n));
    const entityTypes = dedupeNodes(crud.flatMap((m) => [m.returns, ...m.params.map((p) => p.type)]).map((type) => ctx.types.resolve(t.file, parseTypeExpr(type)?.elem)).filter((x): x is TypeNode => !!x && x.id !== t.id && !/(repository|repo|dao)$/i.test(x.info.name)));
    const rawReturns = crud.filter((m) => /^(find|get|fetch|load|read|list|all|query|search)/i.test(m.name) && /^(Map|HashMap|Dictionary|dict|Dict|Object|object|any|Record|Row|array|Array<any>|list\[dict|List<Map|List<Object)/.test((m.returns ?? "").trim()));
    const leaks = crud.filter((m) => /(Query|Cursor|ResultSet|DataFrame|Row|Statement|QuerySet|DbSet|SqlCommand|QueryBuilder)\b/.test(m.returns ?? ""));
    const checks = [
      check("required", crud.length >= 1 || !!frameworkBase, "Collection-like data access", frameworkBase ? `Inherited from ${frameworkBase}${crud.length ? `, plus ${crud.map((m) => m.name).slice(0, 3).join(", ")}` : ""}.` : crud.length ? crud.map((m) => m.name).slice(0, 5).join(", ") : "No find/save/delete style methods."),
      check("recommended", !!frameworkBase || verbs.size >= 2, "Covers several operations", frameworkBase || verbs.size >= 2 ? undefined : `Only "${[...verbs][0] ?? "?"}" operations: a repository usually reads and writes.`),
      check("recommended", !!abstraction || !!frameworkBase, "Behind an interface", frameworkBase ? "Implementation generated by the framework." : abstraction ? (isAbs ? (impls.length ? impls.map((i) => i.info.name).slice(0, 4).join(", ") : "Implementation provided elsewhere.") : `implements ${abstraction.info.name}`) : "No repository interface: callers depend on the concrete data access."),
      check("recommended", rawReturns.length === 0, "Works with domain entities", rawReturns.length ? `${rawReturns.map((m) => m.name).slice(0, 3).join(", ")} return raw maps/rows instead of entities.` : entityTypes.length ? entityTypes.map((e) => e.info.name).slice(0, 3).join(", ") : undefined),
      check("anti", business.length <= crud.length, "No business logic", business.length > crud.length ? `${business.map((m) => m.name).slice(0, 4).join(", ")}… look like business operations.` : undefined),
      check("anti", leaks.length === 0, "No persistence leaks", leaks.length ? `${leaks.map((m) => m.name).join(", ")} expose query/row types.` : undefined),
    ];
    out.push(makeMatch(ctx, "repository", `${t.id}`, { Repository: [abstraction ?? t], Implementation: isAbs ? impls : [t], Entity: entityTypes }, checks, 0.85, `${t.info.name} gives collection-like access to ${entityTypes[0]?.info.name ?? "stored data"}.`));
  }
  return out;
}

export function detectPatterns(base: AnalysisContext): PatternMatch[] {
  const ctx: PatternContext = { ...base, creations: buildCreations(base) };
  const all = [
    ...singleton(ctx), ...factories(ctx), ...builder(ctx), ...observer(ctx), ...strategyAndState(ctx), ...wrappers(ctx),
    ...command(ctx), ...templateMethod(ctx), ...chain(ctx), ...visitor(ctx), ...facade(ctx), ...repository(ctx),
  ];
  // A more specific pattern explains the structure better than a generic one:
  // a builder interface held by a Director, a command held by an invoker, a state... are not "strategies";
  // concrete factories of an abstract factory are not separate simple factories.
  const typeKey = (t: { file: number; name: string }) => `${t.file}:${t.name}`;
  const specific = new Set<string>();
  const concreteCreators = new Set<string>();
  for (const m of all) {
    if (["builder", "command", "abstract-factory", "visitor", "chain", "state", "composite", "factory-method"].includes(m.pattern)) {
      for (const r of m.roles) for (const t of r.types) specific.add(typeKey(t));
      if (m.pattern === "builder") for (const t of m.roles[0].types) for (const a of ctx.types.ancestors(ctx.types.nodes.find((n) => n.file === t.file && n.info.name === t.name)!)) specific.add(typeKey({ file: a.file, name: a.info.name }));
    }
    if (m.pattern === "abstract-factory" || m.pattern === "factory-method") for (const r of m.roles.filter((x) => /concrete (factory|creator)/i.test(x.role))) for (const t of r.types) concreteCreators.add(typeKey(t));
  }
  const filtered = all.filter((m) => {
    if (m.pattern === "strategy") return !m.roles.find((r) => r.role === "Strategy")?.types.some((t) => specific.has(typeKey(t)));
    if (m.pattern === "factory") return !concreteCreators.has(typeKey(m.roles[0].types[0]));
    if (m.pattern === "decorator") return !m.roles[0].types.some((t) => specific.has(typeKey(t)) && all.some((o) => o.pattern === "chain" && o.files.includes(t.file)));
    return true;
  });
  // Keep confident matches; drop duplicates (same pattern, same main participant).
  const seen = new Set<string>();
  return filtered
    .filter((m) => m.confidence >= 0.45)
    .sort((a, b) => b.confidence - a.confidence)
    .filter((m) => {
      const key = `${m.pattern}:${m.roles[0]?.types[0]?.file}:${m.roles[0]?.types[0]?.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
