/** Design patterns the map knows, with their intent (shown on demand) and family. */
export interface PatternInfo {
  id: string;
  name: string;
  family: "creational" | "structural" | "behavioral" | "architectural";
  intent: string;
  /** Short glyph used on the map (1-2 chars). */
  glyph: string;
}

export const PATTERNS: PatternInfo[] = [
  { id: "singleton", name: "Singleton", family: "creational", glyph: "1", intent: "Guarantee a class has exactly one instance and give a global access point to it." },
  { id: "factory", name: "Factory", family: "creational", glyph: "F", intent: "Centralise object creation behind a method that returns an abstraction, so callers don't depend on concrete classes." },
  { id: "factory-method", name: "Factory Method", family: "creational", glyph: "Fm", intent: "Let subclasses decide which concrete product an abstract creator instantiates." },
  { id: "abstract-factory", name: "Abstract Factory", family: "creational", glyph: "AF", intent: "Create families of related objects through an interface, without naming their concrete classes." },
  { id: "builder", name: "Builder", family: "creational", glyph: "B", intent: "Construct a complex object step by step with a fluent API, then produce it in one final call." },
  { id: "adapter", name: "Adapter", family: "structural", glyph: "A", intent: "Make an incompatible class usable through the interface clients expect by translating calls." },
  { id: "decorator", name: "Decorator", family: "structural", glyph: "D", intent: "Add behaviour to an object dynamically by wrapping it in an object with the same interface." },
  { id: "proxy", name: "Proxy", family: "structural", glyph: "Px", intent: "Stand in for another object with the same interface to control access, cache or load lazily." },
  { id: "composite", name: "Composite", family: "structural", glyph: "C", intent: "Treat individual objects and trees of objects uniformly through one component interface." },
  { id: "facade", name: "Facade", family: "structural", glyph: "Fc", intent: "Offer one simple entry point over a complex subsystem." },
  { id: "observer", name: "Observer", family: "behavioral", glyph: "O", intent: "Let objects subscribe to a subject and be notified automatically when it changes." },
  { id: "strategy", name: "Strategy", family: "behavioral", glyph: "S", intent: "Encapsulate interchangeable algorithms behind an interface and pick one at runtime." },
  { id: "state", name: "State", family: "behavioral", glyph: "St", intent: "Let an object change its behaviour when its internal state changes, one class per state." },
  { id: "command", name: "Command", family: "behavioral", glyph: "Cm", intent: "Turn a request into an object so it can be queued, logged or undone." },
  { id: "template-method", name: "Template Method", family: "behavioral", glyph: "T", intent: "Define an algorithm's skeleton in a base class and let subclasses fill in the steps." },
  { id: "chain", name: "Chain of Responsibility", family: "behavioral", glyph: "Ch", intent: "Pass a request along a chain of handlers until one handles it." },
  { id: "visitor", name: "Visitor", family: "behavioral", glyph: "V", intent: "Add operations over an object structure without changing its classes, via double dispatch." },
  { id: "repository", name: "Repository", family: "architectural", glyph: "R", intent: "Mediate between domain and data mapping with a collection-like interface for entities." },
];

export const patternInfo = (id: string) => PATTERNS.find((p) => p.id === id);
