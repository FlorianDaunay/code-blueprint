import { describe, expect, it } from "vitest";
import { extract } from "./index";

const type = (info: ReturnType<typeof extract>, name: string) => {
  const t = info.types.find((x) => x.name === name);
  if (!t) throw new Error(`type ${name} not found in [${info.types.map((x) => x.name).join(", ")}]`);
  return t;
};

describe("typescript", () => {
  const src = `
import { A, B as C } from "./a";
import type { T } from '../types';
import * as path from "node:path";
import Default, { x } from "@/lib/x";
export { y } from "./y";
const lazy = () => import("./lazy");
const s = "class Fake {"; // class Comment {
/* interface Hidden {} */
const re = /class \\{/g;

@Injectable()
export class Singleton {
  private static instance: Singleton | null = null;
  #secret = 1;
  private constructor(private readonly repo: Repo) {}
  static getInstance(): Singleton {
    if (!Singleton.instance) {
      Singleton.instance = new Singleton(new Repo());
    }
    return Singleton.instance;
  }
  handler = (e: Event) => { console.log(\`x \${e}\`) }
  get value(): number { return 1 }
}

export abstract class Shape extends Base<T> implements Drawable, Sizable {
  abstract area(): number;
  protected name: string
  describe() { return this.name }
}

interface Observer { update(event: string): void; id?: number }

export function helper(a: number, b = 2): number {
  return a + b
}
export const make = (kind: string) => new Shape()
`;
  const info = extract(src, "src/app.ts", "typescript");

  it("finds imports", () => {
    expect(info.imports.map((i) => i.spec)).toEqual(["./a", "../types", "node:path", "@/lib/x", "./y", "./lazy"]);
    expect(info.imports[0].names).toEqual(["A", "B"]);
    expect(info.imports[2].alias).toBe("path");
    expect(info.imports[3].names).toContain("default:Default");
  });

  it("ignores classes in strings, comments and regexes", () => {
    expect(info.types.map((t) => t.name).sort()).toEqual(["Observer", "Shape", "Singleton"]);
  });

  it("parses a singleton class", () => {
    const t = type(info, "Singleton");
    expect(t.decorators).toContain("Injectable");
    expect(t.isExported).toBe(true);
    const ctor = t.methods.find((m) => m.kind === "ctor")!;
    expect(ctor.visibility).toBe("private");
    expect(ctor.params[0]).toEqual({ name: "repo", type: "Repo" });
    const inst = t.fields.find((f) => f.name === "instance")!;
    expect(inst.isStatic).toBe(true);
    expect(inst.type).toBe("Singleton | null");
    expect(t.fields.find((f) => f.name === "repo")?.flags).toContain("promoted");
    expect(t.fields.find((f) => f.name === "secret")?.visibility).toBe("private");
    const get = t.methods.find((m) => m.name === "getInstance")!;
    expect(get.isStatic).toBe(true);
    expect(get.returns).toBe("Singleton");
    expect(get.body).toContain("new Singleton");
    expect(t.methods.find((m) => m.name === "handler")).toBeTruthy();
    expect(t.methods.find((m) => m.name === "value")?.kind).toBe("getter");
  });

  it("parses heritage and abstract members", () => {
    const t = type(info, "Shape");
    expect(t.isAbstract).toBe(true);
    expect(t.extends).toEqual(["Base"]);
    expect(t.implements).toEqual(["Drawable", "Sizable"]);
    expect(t.methods.find((m) => m.name === "area")?.isAbstract).toBe(true);
    expect(t.fields.map((f) => f.name)).toEqual(["name"]);
    const o = type(info, "Observer");
    expect(o.kind).toBe("interface");
    expect(o.methods.map((m) => m.name)).toEqual(["update"]);
    expect(o.methods[0].isAbstract).toBe(true);
  });

  it("finds top-level functions", () => {
    expect(info.functions.map((f) => f.name).sort()).toEqual(["helper", "lazy", "make"]);
  });
});

describe("java", () => {
  const src = `
package com.acme.core;

import java.util.List;
import java.util.ArrayList;
import com.acme.events.*;
import static com.acme.util.Strings.join;

/** Doc with class Fake { } */
@Service
public final class EventBus implements Publisher {
    private static volatile EventBus instance;
    private final List<Listener> listeners = new ArrayList<>();

    private EventBus() { }

    public static synchronized EventBus getInstance() {
        if (instance == null) { instance = new EventBus(); }
        return instance;
    }

    @Override
    public void subscribe(Listener l) { listeners.add(l); }
    public void unsubscribe(Listener l) { listeners.remove(l); }
    public void publish(Event e) {
        for (Listener l : listeners) { l.onEvent(e); }
    }
    public interface Listener { void onEvent(Event e); }
}
`;
  const info = extract(src, "src/main/java/com/acme/core/EventBus.java", "java");

  it("reads package and imports", () => {
    expect(info.namespace).toBe("com.acme.core");
    expect(info.imports.map((i) => [i.spec, i.kind])).toEqual([
      ["java.util.List", "type"],
      ["java.util.ArrayList", "type"],
      ["com.acme.events", "namespace"],
      ["com.acme.util.Strings", "type"],
    ]);
  });

  it("parses members", () => {
    const t = type(info, "EventBus");
    expect(t.isFinal).toBe(true);
    expect(t.implements).toEqual(["Publisher"]);
    expect(t.decorators).toContain("Service");
    expect(t.fields.map((f) => [f.name, f.type, f.isStatic])).toEqual([
      ["instance", "EventBus", true],
      ["listeners", "List<Listener>", false],
    ]);
    const ctor = t.methods.find((m) => m.kind === "ctor")!;
    expect(ctor.visibility).toBe("private");
    const gi = t.methods.find((m) => m.name === "getInstance")!;
    expect(gi.flags).toContain("synchronized");
    expect(gi.returns).toBe("EventBus");
    expect(t.methods.find((m) => m.name === "subscribe")?.flags).toContain("@Override");
    expect(type(info, "Listener").kind).toBe("interface");
    expect(t.methods.map((m) => m.name)).not.toContain("onEvent");
  });

  it("collects type refs", () => {
    expect(info.refs).toContain("Listener");
    expect(info.refs).toContain("Event");
  });
});

describe("kotlin", () => {
  const src = `
package com.acme.app

import com.acme.data.Repo
import com.acme.data.Cache as C

object Registry {
    val items = mutableListOf<String>()
    fun register(name: String) { items.add(name) }
}

class Service private constructor(private val repo: Repo) : BaseService(), Closeable {
    companion object {
        @Volatile private var instance: Service? = null
        fun get(repo: Repo): Service = instance ?: synchronized(this) { instance ?: Service(repo).also { instance = it } }
    }
    override fun close() {}
}

data class Point(val x: Int, val y: Int)
`;
  const info = extract(src, "app/src/Service.kt", "kotlin");

  it("handles object, companion, primary constructors", () => {
    expect(info.imports.map((i) => i.spec)).toEqual(["com.acme.data.Repo", "com.acme.data.Cache"]);
    expect(type(info, "Registry").kind).toBe("object");
    const s = type(info, "Service");
    expect(s.extends).toEqual(["BaseService"]);
    expect(s.implements).toEqual(["Closeable"]);
    expect(s.isFinal).toBe(true);
    expect(s.methods.find((m) => m.kind === "ctor")?.visibility).toBe("private");
    expect(s.fields.find((f) => f.name === "instance")?.isStatic).toBe(true);
    expect(s.methods.find((m) => m.name === "get")?.isStatic).toBe(true);
    expect(s.fields.find((f) => f.name === "repo")?.visibility).toBe("private");
    expect(type(info, "Point").fields.map((f) => f.name)).toEqual(["x", "y"]);
  });
});

describe("csharp", () => {
  const src = `
using System;
using System.Collections.Generic;
using Acme.Domain;

namespace Acme.Infrastructure
{
    [Serializable]
    public sealed class Logger : ILogger
    {
        private static readonly Lazy<Logger> _lazy = new Lazy<Logger>(() => new Logger());
        public static Logger Instance => _lazy.Value;
        public string Name { get; private set; }
        public event EventHandler<string> Logged;
        private Logger() { }
        public void Log(string msg) { Logged?.Invoke(this, msg); }
    }

    public class UserRepository : RepositoryBase<User>, IUserRepository
    {
        public User FindById(int id) { return null; }
    }
}
`;
  const info = extract(src, "src/Infrastructure/Logger.cs", "csharp");

  it("parses namespaces, properties and events", () => {
    expect(info.imports.map((i) => i.spec)).toEqual(["System", "System.Collections.Generic", "Acme.Domain"]);
    const t = type(info, "Logger");
    expect(t.namespace).toBe("Acme.Infrastructure");
    expect(t.isFinal).toBe(true);
    expect(t.implements).toEqual(["ILogger"]);
    expect(t.methods.find((m) => m.name === "Instance")).toMatchObject({ kind: "getter", isStatic: true });
    expect(t.fields.find((f) => f.name === "Name")?.isReadonly).toBe(true);
    expect(t.fields.find((f) => f.name === "Logged")?.flags).toContain("event");
    expect(t.methods.find((m) => m.kind === "ctor")?.visibility).toBe("private");
    const r = type(info, "UserRepository");
    expect(r.extends).toEqual(["RepositoryBase"]);
    expect(r.implements).toEqual(["IUserRepository"]);
  });
});

describe("php", () => {
  const src = `<?php
namespace App\\Services;

use App\\Models\\User;
use App\\Contracts\\{Mailer, Queue as Q};
require_once __DIR__ . '/helpers.php';

final class Config {
    private static ?Config $instance = null;
    private array $items = [];
    private function __construct(private string $env) {}
    public static function getInstance(): static {
        return self::$instance ??= new static('prod');
    }
}
`;
  const info = extract(src, "app/Services/Config.php", "php");

  it("parses use statements and static accessors", () => {
    expect(info.imports.map((i) => i.spec)).toEqual(["App\\Models\\User", "App\\Contracts\\Mailer", "App\\Contracts\\Queue", "./helpers.php"]);
    const t = type(info, "Config");
    expect(t.namespace).toBe("App\\Services");
    expect(t.fields.map((f) => f.name)).toEqual(["instance", "items", "env"]);
    expect(t.methods.find((m) => m.kind === "ctor")?.visibility).toBe("private");
    expect(t.methods.find((m) => m.name === "getInstance")?.isStatic).toBe(true);
  });
});

describe("python", () => {
  const src = `
import os, sys as system
from . import utils
from ..core.models import (User,
    Group)
from abc import ABC, abstractmethod

class Base(ABC):
    """class Fake:"""
    registry = {}

    @abstractmethod
    def run(self, x: int) -> str:
        ...

class Singleton(metaclass=SingletonMeta):
    _instance = None

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self, name: str):
        self.name = name
        self._observers: list[Observer] = []

    @staticmethod
    def create():
        return Singleton("x")

def top(a, b=1):
    return a
CONSTANT = 3
`;
  const info = extract(src, "pkg/sub/mod.py", "python");

  it("parses imports", () => {
    expect(info.imports.map((i) => [i.spec, i.level, i.names])).toEqual([
      ["os", 0, ["*"]],
      ["sys", 0, ["*"]],
      ["", 1, ["utils"]],
      ["core.models", 2, ["User", "Group"]],
      ["abc", 0, ["ABC", "abstractmethod"]],
    ]);
  });

  it("parses classes", () => {
    expect(info.types.map((t) => t.name)).toEqual(["Base", "Singleton"]);
    const b = type(info, "Base");
    expect(b.isAbstract).toBe(true);
    expect(b.kind).toBe("interface");
    expect(b.methods[0]).toMatchObject({ name: "run", isAbstract: true, returns: "str" });
    const s = type(info, "Singleton");
    expect(s.decorators).toContain("metaclass:SingletonMeta");
    expect(s.methods.map((m) => m.name)).toEqual(["__new__", "__init__", "create"]);
    expect(s.fields.map((f) => f.name)).toEqual(["_instance", "name", "_observers"]);
    expect(s.fields.find((f) => f.name === "_observers")?.type).toBe("list[Observer]");
    expect(s.methods.find((m) => m.name === "create")?.isStatic).toBe(true);
    expect(info.functions.map((f) => f.name)).toEqual(["top"]);
    expect(info.variables.map((v) => v.name)).toEqual(["CONSTANT"]);
  });
});

describe("go", () => {
  const src = `
package store

import (
	"fmt"
	"sync"
	db "github.com/acme/app/internal/db"
)

type Store struct {
	mu    sync.Mutex
	items map[string]Item
	Base
}

type Reader interface {
	Get(key string) (Item, error)
	io.Closer
}

var (
	instance *Store
	once     sync.Once
)

func GetInstance() *Store {
	once.Do(func() { instance = &Store{} })
	return instance
}

func (s *Store) Get(key string) (Item, error) {
	fmt.Println(db.Open())
	return s.items[key], nil
}
`;
  const info = extract(src, "internal/store/store.go", "go");

  it("parses imports, structs, interfaces and receivers", () => {
    expect(info.namespace).toBe("store");
    expect(info.imports.map((i) => [i.spec, i.alias])).toEqual([
      ["fmt", undefined],
      ["sync", undefined],
      ["github.com/acme/app/internal/db", "db"],
    ]);
    const s = type(info, "Store");
    expect(s.fields.map((f) => f.name)).toEqual(["mu", "items"]);
    expect(s.extends).toEqual(["Base"]);
    expect(s.methods.map((m) => m.name)).toEqual(["Get"]);
    expect(type(info, "Reader").methods.map((m) => m.name)).toEqual(["Get"]);
    expect(info.functions.map((f) => f.name)).toEqual(["GetInstance"]);
    expect(info.variables.map((v) => v.name)).toEqual(["instance", "once"]);
    expect(info.selectors).toContain("db.Open");
  });
});

describe("python TYPE_CHECKING", () => {
  it("ignores imports only used for type hints", () => {
    const info = extract("from typing import TYPE_CHECKING\nimport os\nif TYPE_CHECKING:\n    from .app import Flask\n    import typing as t\nfrom .ctx import AppContext\n", "pkg/x.py", "python");
    expect(info.imports.map((i) => i.spec)).toEqual(["typing", "os", "ctx"]);
  });
});

describe("python docstrings", () => {
  it("ignores import lines inside docstrings", () => {
    const info = extract('"""Usage:\n\nfrom flask import Flask\nimport name of your app\n"""\nfrom .ctx import AppContext\n', "pkg/app.py", "python");
    expect(info.imports.map((i) => i.spec)).toEqual(["ctx"]);
  });
});
