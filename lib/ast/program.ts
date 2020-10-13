// -*- mode: typescript; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingTalk
//
// Copyright 2018-2020 The Board of Trustees of the Leland Stanford Junior University
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//         Silei Xu <silei@cs.stanford.edu>
import assert from 'assert';

import Type, { TypeMap } from '../type';
import Node, {
    SourceRange,
    NLAnnotationMap,
    AnnotationMap,
    AnnotationSpec,
} from './base';
import NodeVisitor from './visitor';
import { Value, ArrayValue, VarRefValue } from './values';
import { DeviceSelector, InputParam, BooleanExpression } from './expression';
import {
    Stream,
    Table,
    Action,
    PermissionFunction
} from './primitive';
import { ClassDef } from './class_def';
import { FunctionDef, ExpressionSignature } from './function_def';
import {
    recursiveYieldArraySlots,
    AbstractSlot,
    FieldSlot,
    OldSlot
} from './slots';
import {
    prettyprint,
    prettyprintExample,
    prettyprintDataset
} from '../prettyprint';
import * as Typechecking from '../typecheck';
import * as Optimizer from '../optimize';
import convertToPermissionRule from './convert_to_permission_rule';
import lowerReturn, { Messaging } from './lower_return';
import SchemaRetriever from '../schema';
import type {
    ExpressionStatement
} from './program2';

import { TokenStream } from '../new-syntax/tokenstream';
import List from '../utils/list';

/**
 * The base class of all AST nodes that represent complete ThingTalk
 * statements.
 *
 * @alias Ast.Statement
 * @extends Ast~Node
 * @abstract
 */
export abstract class Statement extends Node {
    static Rule : typeof Rule;
    isRule ! : boolean;
    static Command : typeof Command;
    isCommand ! : boolean;
    static Assignment : typeof Assignment;
    isAssignment ! : boolean;
    static OnInputChoice : typeof OnInputChoice;
    isOnInputChoice ! : boolean;
    static Declaration : typeof Declaration;
    isDeclaration ! : boolean;
    static Dataset : typeof Dataset;
    isDataset ! : boolean;
    static ClassDef : typeof ClassDef;
    isClassDef ! : boolean;
    static Expression : typeof ExpressionStatement;
    isExpression ! : boolean;

    /**
     * Iterate all slots (scalar value nodes) in this statement.
     *
     * @deprecated This method is only appropriate for filters and input parameters.
     *   You should use {@link Ast.Statement#iterateSlots2} instead.
     */
    abstract iterateSlots() : Generator<OldSlot, void>;

    /**
     * Iterate all slots (scalar value nodes) in this statement.
     */
    abstract iterateSlots2() : Generator<DeviceSelector|AbstractSlot, void>;

    /**
     * Clone this statement.
     */
    abstract clone() : Statement;
}
Statement.prototype.isRule = false;
Statement.prototype.isCommand = false;
Statement.prototype.isAssignment = false;
Statement.prototype.isOnInputChoice = false;
Statement.prototype.isDeclaration = false;
Statement.prototype.isDataset = false;
Statement.prototype.isClassDef = false;
Statement.prototype.isExpression = false;

function declarationLikeToProgram(self : Declaration|Example) : Program {
    const nametoslot : { [key : string] : number } = {};

    let i = 0;
    for (const name in self.args)
        nametoslot[name] = i++;

    let program : Program;
    if (self.type === 'action') {
        program = new Program(null, [], [],
            [new Statement.Command(null, null, [(self.value as Action).clone()])], null);
    } else if (self.type === 'query') {
        program = new Program(null, [], [],
            [new Statement.Command(null, (self.value as Table).clone(), [Action.notifyAction()])], null);
    } else if (self.type === 'stream') {
        program = new Program(null, [], [],
            [new Statement.Rule(null, (self.value as Stream).clone(), [Action.notifyAction()])], null);
    } else {
        program = (self.value as Program).clone();
    }

    function recursiveHandleSlot(value : Value) : void {
        if (value instanceof VarRefValue && value.name in nametoslot) {
            value.name = '__const_SLOT_' + nametoslot[value.name];
        } else if (value instanceof ArrayValue) {
            for (const v of value.value)
                recursiveHandleSlot(v);
        }
    }

    for (const slot of program.iterateSlots2()) {
        if (slot instanceof DeviceSelector)
            continue;
        recursiveHandleSlot(slot.get());
    }

    return program;
}

type DeclarationType = ('stream'|'query'|'action'|'program'|'procedure');

/**
 * `let` statements, that bind a ThingTalk expression to a name.
 *
 * A declaration statement creates a new, locally scoped, function
 * implemented as ThingTalk expression. The name can then be invoked
 * in subsequent statements.
 *
 * @alias Ast.Statement.Declaration
 * @extends Ast.Statement
 */
export class Declaration extends Statement {
    name : string;
    type : DeclarationType;
    args : TypeMap;
    value : (Table|Stream|Action|Program);
    nl_annotations : NLAnnotationMap;
    impl_annotations : AnnotationMap;
    schema : FunctionDef|null;

    /**
     * Construct a new declaration statement.
     *
     * @param location - the position of this node in the source code
     * @param name - the name being bound by this statement
     * @param type - what type of function is being declared,
     *                        either `stream`, `query`, `action`, `program` or `procedure`
     * @param args - any arguments available to the function
     * @param value - the declaration body
     * @param metadata - declaration metadata (translatable annotations)
     * @param annotations - declaration annotations
     * @param schema - the type definition corresponding to this declaration
     */
    constructor(location : SourceRange|null,
                name : string,
                type : DeclarationType,
                args : TypeMap,
                value : (Table|Stream|Action|Program),
                metadata : NLAnnotationMap = {},
                annotations : AnnotationMap = {},
                schema : FunctionDef|null = null) {
        super(location);

        assert(typeof name === 'string');
        /**
         * The name being bound by this statement.
         * @type {string}
         */
        this.name = name;

        assert(['stream', 'query', 'action', 'program', 'procedure'].indexOf(type) >= 0);
        /**
         * What type of function is being declared, either `stream`, `query`, `action`,
         * `program` or `procedure`.
         */
        this.type = type;

        assert(typeof args === 'object');
        /**
         * Arguments available to the function.
         */
        this.args = args;

        assert(value instanceof Stream || value instanceof Table || value instanceof Action || value instanceof Program);
        /**
         * The declaration body.
         */
        this.value = value;

        /**
         * The declaration natural language annotations (translatable annotations).
         */
        this.nl_annotations = metadata;
        /**
         * The declaration annotations.
         */
        this.impl_annotations = annotations;
        /**
         * The type definition corresponding to this declaration.
         *
         * This property is guaranteed not `null` after type-checking.
         */
        this.schema = schema;
    }

    get metadata() : NLAnnotationMap {
        return this.nl_annotations;
    }
    get annotations() : AnnotationMap {
        return this.impl_annotations;
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        if (visitor.visitDeclaration(this))
            this.value.visit(visitor);
        visitor.exit(this);
    }

    *iterateSlots() : Generator<OldSlot, void> {
        // if the declaration refers to a nested scope, we don't need to
        // slot fill it now
        if (this.type === 'program' || this.type === 'procedure')
            return;

        yield* this.value.iterateSlots({});
    }
    *iterateSlots2() : Generator<DeviceSelector|AbstractSlot, void> {
        // if the declaration refers to a nested scope, we don't need to
        // slot fill it now
        if (this.type === 'program' || this.type === 'procedure')
            return;

        yield* this.value.iterateSlots2({});
    }

    clone() : Declaration {
        const newArgs = {};
        Object.assign(newArgs, this.args);

        const newMetadata = {};
        Object.assign(newMetadata, this.nl_annotations);
        const newAnnotations = {};
        Object.assign(newAnnotations, this.impl_annotations);
        return new Declaration(this.location, this.name, this.type, newArgs,
            this.value.clone(), newMetadata, newAnnotations, this.schema);
    }

    /**
     * Convert a declaration to a program.
     *
     * This will create a program that invokes the same code as the declaration value,
     * and will replace all parameters with slots.
     *
     * @return {Ast.Program} the new program
     */
    toProgram() : Program {
        return declarationLikeToProgram(this);
    }
}
Declaration.prototype.isDeclaration = true;
Statement.Declaration = Declaration;

/**
 * `let result` statements, that assign the value of a ThingTalk expression to a name.
 *
 * Assignment statements are executable statements that evaluate the ThingTalk expression
 * and assign the result to the name, which becomes available for later use in the program.
 *
 * @alias Ast.Statement.Assignment
 * @extends Ast.Statement
 */
export class Assignment extends Statement {
    name : string;
    value : Table;
    schema : ExpressionSignature|null;
    isAction : boolean;

    /**
     * Construct a new assignment statement.
     *
     * @param {Ast~SourceRange|null} location - the position of this node
     *        in the source code
     * @param {string} name - the name being assigned to
     * @param {Ast.Table} value - the expression being assigned
     * @param {Ast.ExpressionSignature | null} schema - the signature corresponding to this assignment
     */
    constructor(location : SourceRange|null,
                name : string,
                value : Table,
                schema : ExpressionSignature|null = null,
                isAction : boolean) {
        super(location);

        assert(typeof name === 'string');
        /**
         * The name being assigned to.
         * @type {string}
         */
        this.name = name;

        assert(value instanceof Table);
        /**
         * The expression being assigned.
         * @type {Ast.Table}
         */
        this.value = value;

        /**
         * The signature corresponding to this assignment.
         *
         * This is the type that the assigned name has after the assignment statement.
         * This property is guaranteed not `null` after type-checking.
         * @type {Ast.ExpressionSignature|null}
         */
        this.schema = schema;

        /**
         * Whether this assignment calls an action or executes a query.
         *
         * This will be `undefined` before typechecking, and then either `true` or `false`.
         * @type {boolean}
         */
        this.isAction = isAction;
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        if (visitor.visitAssignment(this))
            this.value.visit(visitor);
        visitor.exit(this);
    }

    *iterateSlots() : Generator<OldSlot, void> {
        yield* this.value.iterateSlots({});
    }
    *iterateSlots2() : Generator<DeviceSelector|AbstractSlot, void> {
        yield* this.value.iterateSlots2({});
    }

    clone() : Assignment {
        return new Assignment(this.location, this.name, this.value.clone(), this.schema, this.isAction);
    }
}
Assignment.prototype.isAssignment = true;
Statement.Assignment = Assignment;

/**
 * A statement that executes one or more actions for each element
 * of a stream.
 *
 * @alias Ast.Statement.Rule
 * @extends Ast.Statement
 */
export class Rule extends Statement {
    stream : Stream;
    actions : Action[];

    /**
     * Construct a new rule statement.
     *
     * @param location - the position of this node
     *        in the source code
     * @param stream - the stream to react to
     * @param actions - the actions to execute
     */
    constructor(location : SourceRange|null,
                stream : Stream,
                actions : Action[]) {
        super(location);

        assert(stream instanceof Stream);
        this.stream = stream;

        assert(Array.isArray(actions));
        this.actions = actions;
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        if (visitor.visitRule(this)) {
            this.stream.visit(visitor);
            for (const action of this.actions)
                action.visit(visitor);
        }
        visitor.exit(this);
    }

    *iterateSlots() : Generator<OldSlot, void> {
        const [,scope] = yield* this.stream.iterateSlots({});
        for (const action of this.actions)
            yield* action.iterateSlots(scope);
    }
    *iterateSlots2() : Generator<DeviceSelector|AbstractSlot, void> {
        const [,scope] = yield* this.stream.iterateSlots2({});
        for (const action of this.actions)
            yield* action.iterateSlots2(scope);
    }

    clone() : Rule {
        return new Rule(this.location, this.stream.clone(), this.actions.map((a) => a.clone()));
    }
}
Rule.prototype.isRule = true;
Statement.Rule = Rule;

/**
 * A statement that executes one or more actions immediately, potentially
 * reading data from a query.
 *
 * @alias Ast.Statement.Command
 * @extends Ast.Statement
 */
export class Command extends Statement {
    table : Table|null;
    actions : Action[];

    /**
     * Construct a new command statement.
     *
     * @param {Ast~SourceRange|null} location - the position of this node
     *        in the source code
     * @param {Ast.Table|null} table - the table to read from
     * @param {Ast.Action[]} actions - the actions to execute
     */
    constructor(location : SourceRange|null,
                table : Table|null,
                actions : Action[]) {
        super(location);

        assert(table === null || table instanceof Table);
        this.table = table;

        assert(Array.isArray(actions));
        this.actions = actions;
    }

    toSource() : TokenStream {
        assert(this.actions.length === 1);
        if (this.table)
            return List.concat(this.table.toSource(), '=>', this.actions[0].toSource(), ';');
        else
            return List.concat(this.actions[0].toSource(), ';');
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        if (visitor.visitCommand(this)) {
            if (this.table !== null)
                this.table.visit(visitor);
            for (const action of this.actions)
                action.visit(visitor);
        }
        visitor.exit(this);
    }

    *iterateSlots() : Generator<OldSlot, void> {
        let scope = {};
        if (this.table)
            [,scope] = yield* this.table.iterateSlots({});
        for (const action of this.actions)
            yield* action.iterateSlots(scope);
    }
    *iterateSlots2() : Generator<DeviceSelector|AbstractSlot, void> {
        let scope = {};
        if (this.table)
            [,scope] = yield* this.table.iterateSlots2({});
        for (const action of this.actions)
            yield* action.iterateSlots2(scope);
    }

    clone() : Command {
        return new Command(this.location,
            this.table !== null ? this.table.clone() : null,
            this.actions.map((a) => a.clone()));
    }
}
Command.prototype.isCommand = true;
Statement.Command = Command;

/**
 * A statement that interactively prompts the user for one or more choices.
 *
 * @alias Ast.Statement.OnInputChoice
 * @extends Ast.Statement
 */
export class OnInputChoice extends Statement {
    table : Table|null;
    actions : Action[];
    nl_annotations : NLAnnotationMap;
    impl_annotations : AnnotationMap;

    /**
     * Construct a new on-input statement.
     *
     * @param {Ast~SourceRange|null} location - the position of this node
     *        in the source code
     * @param {Ast.Table|null} table - the table to read from
     * @param {Ast.Action[]} actions - the actions to execute
     * @param {Object.<string, any>} [metadata={}] - natural language annotations of the statement (translatable annotations)
     * @param {Object.<string, Ast.Value>} [annotations={}]- implementation annotations
     */
    constructor(location : SourceRange|null,
                table : Table|null,
                actions : Action[],
                metadata : NLAnnotationMap = {},
                annotations : AnnotationMap = {}) {
        super(location);

        assert(table === null || table instanceof Table);
        this.table = table;

        assert(Array.isArray(actions));
        this.actions = actions;

        this.nl_annotations = metadata;
        this.impl_annotations = annotations;
    }

    get metadata() : NLAnnotationMap {
        return this.nl_annotations;
    }
    get annotations() : AnnotationMap {
        return this.impl_annotations;
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        if (visitor.visitOnInputChoice(this)) {
            if (this.table !== null)
                this.table.visit(visitor);
            for (const action of this.actions)
                action.visit(visitor);
        }
        visitor.exit(this);
    }

    *iterateSlots() : Generator<OldSlot, void> {
        let scope = {};
        if (this.table)
            [,scope] = yield* this.table.iterateSlots({});
        for (const action of this.actions)
            yield* action.iterateSlots(scope);
    }
    *iterateSlots2() : Generator<DeviceSelector|AbstractSlot, void> {
        let scope = {};
        if (this.table)
            [,scope] = yield* this.table.iterateSlots2({});
        for (const action of this.actions)
            yield* action.iterateSlots2(scope);
    }

    clone() : OnInputChoice {
        const newMetadata = {};
        Object.assign(newMetadata, this.nl_annotations);

        const newAnnotations = {};
        Object.assign(newAnnotations, this.impl_annotations);
        return new OnInputChoice(
            this.location,
            this.table !== null ? this.table.clone() : null,
            this.actions.map((a) => a.clone()),
            newMetadata,
            newAnnotations);
    }
}
OnInputChoice.prototype.isOnInputChoice = true;
Statement.OnInputChoice = OnInputChoice;

/**
 * A statement that declares a ThingTalk dataset (collection of primitive
 * templates).
 *
 * @alias Ast.Dataset
 * @extends Ast.Statement
 */
export class Dataset extends Statement {
    name : string;
    language : string;
    examples : Example[];
    annotations : AnnotationMap;

    /**
     * Construct a new dataset.
     *
     * @param location - the position of this node in the source code
     * @param name - the name of this dataset
     * @param language - the language code of this dataset, as 2 letter ISO code
     * @param examples - the examples in this dataset
     * @param [annotations={}]- dataset annotations
     */
    constructor(location : SourceRange|null,
                name : string,
                language : string,
                examples : Example[],
                annotations : AnnotationMap = {}) {
        super(location);

        assert(typeof name === 'string');
        this.name = name;

        assert(typeof language === 'string');
        this.language = language;

        assert(Array.isArray(examples)); // of Example
        this.examples = examples;

        assert(typeof annotations === 'object');
        this.annotations = annotations;
    }

    /**
     * Convert this dataset to prettyprinted ThingTalk code.
     *
     * @param {string} [prefix] - prefix each output line with this string (for indentation)
     * @return {string} the prettyprinted code
     */
    prettyprint(prefix = '') : string {
        return prettyprintDataset(this, prefix);
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        if (visitor.visitDataset(this)) {
            for (const example of this.examples)
                example.visit(visitor);
        }
        visitor.exit(this);
    }

    *iterateSlots() : Generator<OldSlot, void> {
        for (const ex of this.examples)
            yield* ex.iterateSlots();
    }
    *iterateSlots2() : Generator<DeviceSelector|AbstractSlot, void> {
        for (const ex of this.examples)
            yield* ex.iterateSlots2();
    }

    clone() : Dataset {
        const newAnnotations = {};
        Object.assign(newAnnotations, this.annotations);
        return new Dataset(this.location,
            this.name, this.language, this.examples.map((e) => e.clone()), newAnnotations);
    }
}
Dataset.prototype.isDataset = true;
Statement.Dataset = Dataset;

/**
 * A collection of Statements from the same source file.
 *
 * It is somewhat organized for "easier" API handling,
 * and for backward compatibility with API users.
 *
 * @alias Ast.Input
 * @extends Ast.Node
 * @abstract
 */
export abstract class Input extends Node {
    static Bookkeeping : any;
    isBookkeeping ! : boolean;
    static Program : any;
    isProgram ! : boolean;
    static Program2 : any;
    isProgram2 ! : boolean;
    static Library : any;
    isLibrary ! : boolean;
    static PermissionRule : any;
    isPermissionRule ! : boolean;
    static Meta : any;
    isMeta ! : boolean;
    static DialogueState : any;
    isDialogueState ! : boolean;

    *iterateSlots() : Generator<OldSlot, void> {
    }
    *iterateSlots2() : Generator<DeviceSelector|AbstractSlot, void> {
    }

    optimize() : Input|null {
        return this;
    }
    abstract clone() : Input;

    /**
     * Convert this ThingTalk input to prettyprinted ThingTalk code.
     *
     * @param {string} [prefix] - prefix each output line with this string (for indentation)
     * @return {string} the prettyprinted code
     */
    prettyprint(short = true) : string {
        return prettyprint(this, short);
    }

    /**
     * Typecheck this ThingTalk input.
     *
     * This is the main API to typecheck a ThingTalk input.
     *
     * @method Ast.Input#typecheck
     * @param schemas - schema retriever object to retrieve Thingpedia information
     * @param [getMeta=false] - retreive natural language metadata during typecheck
     */
    abstract typecheck(schemas : SchemaRetriever, getMeta : boolean) : Promise<this>;
}
Input.prototype.isBookkeeping = false;
Input.prototype.isProgram = false;
Input.prototype.isProgram2 = false;
Input.prototype.isLibrary = false;
Input.prototype.isPermissionRule = false;
Input.prototype.isMeta = false;
Input.prototype.isDialogueState = false;

export type ExecutableStatement = Assignment | Rule | Command;

/**
 * An executable ThingTalk program (containing at least one executable
 * statement).
 *
 * @alias Ast.Program
 * @extends Ast.Input
 */
export class Program extends Input {
    classes : ClassDef[];
    declarations : Declaration[];
    rules : ExecutableStatement[];
    principal : Value|null;
    oninputs : OnInputChoice[];

    /**
     * Construct a new ThingTalk program.
     *
     * @param {Ast~SourceRange|null} location - the position of this node
     *        in the source code
     * @param {Ast.ClassDef[]} classes - locally defined classes
     * @param {Ast.Statement.Declaration[]} declarations - declaration statements
     * @param {Ast.Statement[]} rules - executable statements (rules and commands)
     * @param {Ast.Value|null} principal - executor of this program
     * @param {Ast.Statement.OnInputChoice[]} - on input continuations of this program
     */
    constructor(location : SourceRange|null,
                classes : ClassDef[],
                declarations : Declaration[],
                rules : ExecutableStatement[],
                principal : Value|null = null,
                oninputs : OnInputChoice[] = []) {
        super(location);
        assert(Array.isArray(classes));
        this.classes = classes;
        assert(Array.isArray(declarations));
        this.declarations = declarations;
        assert(Array.isArray(rules));
        this.rules = rules;
        assert(principal === null || principal instanceof Value);
        this.principal = principal;
        assert(Array.isArray(oninputs));
        this.oninputs = oninputs;
    }

    toSource() : TokenStream {
        let input : TokenStream = List.Nil;
        for (const classdef of this.classes)
            input = List.concat(input, classdef.toSource());
        for (const decl of this.declarations)
            input = List.concat(input, decl.toSource());
        for (const stmt of this.rules)
            input = List.concat(input, stmt.toSource());
        return input;
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        if (visitor.visitProgram(this)) {
            if (this.principal !== null)
                this.principal.visit(visitor);
            for (const classdef of this.classes)
                classdef.visit(visitor);
            for (const decl of this.declarations)
                decl.visit(visitor);
            for (const rule of this.rules)
                rule.visit(visitor);
            for (const onInput of this.oninputs)
                onInput.visit(visitor);
        }
        visitor.exit(this);
    }

    *iterateSlots() : Generator<OldSlot, void> {
        for (const decl of this.declarations)
            yield* decl.iterateSlots();
        for (const rule of this.rules)
            yield* rule.iterateSlots();
        for (const oninput of this.oninputs)
            yield* oninput.iterateSlots();
    }
    *iterateSlots2() : Generator<DeviceSelector|AbstractSlot, void> {
        if (this.principal !== null)
            yield* recursiveYieldArraySlots(new FieldSlot(null, {}, new Type.Entity('tt:contact'), this, 'program', 'principal'));
        for (const decl of this.declarations)
            yield* decl.iterateSlots2();
        for (const rule of this.rules)
            yield* rule.iterateSlots2();
        for (const oninput of this.oninputs)
            yield* oninput.iterateSlots2();
    }

    clone() : Program {
        return new Program(
            this.location,
            this.classes.map((c) => c.clone()),
            this.declarations.map((d) => d.clone()),
            this.rules.map((r) => r.clone()),
            this.principal !== null ? this.principal.clone() : null,
            this.oninputs.map((o) => o.clone())
        );
    }

    optimize() : Program {
        return Optimizer.optimizeProgram(this);
    }

    /**
     * Attempt to convert this program to an equivalent permission rule.
     *
     * @param principal - the principal to use as source
     * @param contactName - the display value for the principal
     * @return the new permission rule, or `null` if conversion failed
     */
    convertToPermissionRule(principal : string, contactName : string|null) : PermissionRule|null {
        return convertToPermissionRule(this, principal, contactName);
    }

    lowerReturn(messaging : Messaging) : Program[] {
        return lowerReturn(this, messaging);
    }

    async typecheck(schemas : SchemaRetriever, getMeta = false) : Promise<this> {
        await Typechecking.typeCheckProgram(this, schemas, getMeta);
        return this;
    }
}
Program.prototype.isProgram = true;
Input.Program = Program;

/**
 * An ThingTalk program definining a permission control policy.
 *
 * @alias Ast.PermissionRule
 * @extends Ast.Input
 */
export class PermissionRule extends Input {
    principal : BooleanExpression;
    query : PermissionFunction;
    action : PermissionFunction;

    /**
     * Construct a new permission rule.
     *
     * @param {Ast~SourceRange|null} location - the position of this node
     *        in the source code
     * @param {Ast.BooleanExpression} principal - the predicate selecting
     *        the source of the program this rule is applicable to
     * @param {Ast.PermissionFunction} query - a permission function for the query part
     * @param {Ast.PermissionFunction} action - a permission function for the action part
     */
    constructor(location : SourceRange|null,
                principal : BooleanExpression,
                query : PermissionFunction,
                action : PermissionFunction) {
        super(location);

        assert(principal instanceof BooleanExpression);
        this.principal = principal;

        assert(query instanceof PermissionFunction);
        this.query = query;

        assert(action instanceof PermissionFunction);
        this.action = action;
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        if (visitor.visitPermissionRule(this)) {
            this.principal.visit(visitor);
            this.query.visit(visitor);
            this.action.visit(visitor);
        }
        visitor.exit(this);
    }

    *iterateSlots() : Generator<OldSlot, void> {
        yield* this.principal.iterateSlots(null, null, {});

        const [,scope] = yield* this.query.iterateSlots({});
        yield* this.action.iterateSlots(scope);
    }
    *iterateSlots2() : Generator<DeviceSelector|AbstractSlot, void> {
        yield* this.principal.iterateSlots2(null, null, {});

        const [,scope] = yield* this.query.iterateSlots2({});
        yield* this.action.iterateSlots2(scope);
    }

    clone() : PermissionRule {
        return new PermissionRule(this.location,
            this.principal.clone(), this.query.clone(), this.action.clone());
    }

    async typecheck(schemas : SchemaRetriever, getMeta = false) : Promise<this> {
        await Typechecking.typeCheckPermissionRule(this, schemas, getMeta);
        return this;
    }
}
PermissionRule.prototype.isPermissionRule = true;
Input.PermissionRule = PermissionRule;

/**
 * An ThingTalk input file containing a library of classes and datasets.
 *
 * @alias Ast.Library
 * @extends Ast.Input
 */
export class Library extends Input {
    classes : ClassDef[];
    datasets : Dataset[];

    /**
     * Construct a new ThingTalk library.
     *
     * @param {Ast~SourceRange|null} location - the position of this node
     *        in the source code
     * @param {Ast.ClassDef[]} classes - classes defined in the library
     * @param {Ast.Dataset[]} datasets - datasets defined in the library
     */
    constructor(location : SourceRange|null,
                classes : ClassDef[],
                datasets : Dataset[]) {
        super(location);
        assert(Array.isArray(classes));
        this.classes = classes;
        assert(Array.isArray(datasets));
        this.datasets = datasets;
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        if (visitor.visitLibrary(this)) {
            for (const classdef of this.classes)
                classdef.visit(visitor);
            for (const dataset of this.datasets)
                dataset.visit(visitor);
        }
        visitor.exit(this);
    }

    *iterateSlots() : Generator<OldSlot, void> {
        for (const dataset of this.datasets)
            yield* dataset.iterateSlots();
    }
    *iterateSlots2() : Generator<DeviceSelector|AbstractSlot, void> {
        for (const dataset of this.datasets)
            yield* dataset.iterateSlots2();
    }

    clone() : Library {
        return new Library(this.location,
            this.classes.map((c) => c.clone()), this.datasets.map((d) => d.clone()));
    }

    async typecheck(schemas : SchemaRetriever, getMeta = false) : Promise<this> {
        await Typechecking.typeCheckMeta(this, schemas, getMeta);
        return this;
    }
}
Library.prototype.isLibrary = true;
Input.Library = Library;
// API backward compat
Library.prototype.isMeta = true;
Input.Meta = Library;

/**
 * A single example (primitive template) in a ThingTalk dataset
 *
 * @alias Ast.Example
 */
export class Example extends Node {
    isExample = true;
    id : number;
    type : DeclarationType;
    args : TypeMap;
    value : (Stream|Table|Action|Program);
    utterances : string[];
    preprocessed : string[];
    annotations : AnnotationMap;

    /**
     * Construct a new example.
     *
     * @param location - the position of this node in the source code
     * @param id - the ID of the example, or -1 if the example has no ID
     * @param {string} type - the type of this example, one of `stream`, `query`,
     *        `action`, or `program`
     * @param {Ast.Stream|Ast.Table|Ast.Action|Ast.Program} - the code this example
     *        maps to
     * @param {string[]} utterances - raw, unprocessed utterances for this example
     * @param {string[]} preprocessed - preprocessed (tokenized) utterances for this example
     * @param {Object.<string, any>} annotations - other annotations for this example
     */
    constructor(location : SourceRange|null,
                id : number,
                type : DeclarationType,
                args : TypeMap,
                value : (Stream|Table|Action|Program),
                utterances : string[],
                preprocessed : string[],
                annotations : AnnotationMap) {
        super(location);

        assert(typeof id === 'number');
        this.id = id;

        assert(['stream', 'query', 'action', 'program'].includes(type));
        this.type = type;

        assert(typeof args === 'object');
        this.args = args;

        assert(value instanceof Stream || value instanceof Table || value instanceof Action || value instanceof Input);
        this.value = value;

        assert(Array.isArray(utterances) && Array.isArray(preprocessed));
        this.utterances = utterances;
        this.preprocessed = preprocessed;

        assert(typeof annotations === 'object');
        this.annotations = annotations;
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        if (visitor.visitExample(this))
            this.value.visit(visitor);
        visitor.exit(this);
    }

    clone() : Example {
        return new Example(
            this.location,
            this.id,
            this.type,
            Object.assign({}, this.args),
            this.value.clone(),
            this.utterances.slice(0),
            this.preprocessed.slice(0),
            Object.assign({}, this.annotations)
        );
    }

    /**
     * Convert this example to prettyprinted ThingTalk code.
     *
     * @param {string} [prefix] - prefix each output line with this string (for indentation)
     * @return {string} the prettyprinted code
     */
    prettyprint(prefix = '') : string {
        return prettyprintExample(this, prefix);
    }

    /**
     * Typecheck this example.
     *
     * This method can be used to typecheck an example is isolation,
     * outside of a ThingTalk program. This is useful to typecheck a dataset
     * and discard examples that do not typecheck without failing the whole dataset.
     *
     * @param schemas - schema retriever object to retrieve Thingpedia information
     * @param [getMeta=false] - retrieve natural language metadata during typecheck
     */
    async typecheck(schemas : SchemaRetriever, getMeta = false) : Promise<Example> {
        await Typechecking.typeCheckExample(this, schemas, {}, getMeta);
        return this;
    }

    /**
     * Iterate all slots (scalar value nodes) in this example.
     *
     * @generator
     * @yields {Ast~OldSlot}
     * @deprecated Use {@link Ast.Example#iterateSlots2} instead.
     */
    *iterateSlots() : Generator<OldSlot, void> {
        yield* this.value.iterateSlots({});
    }

    /**
     * Iterate all slots (scalar value nodes) in this example.
     *
     * @generator
     * @yields {Ast~AbstractSlot}
     */
    *iterateSlots2() : Generator<DeviceSelector|AbstractSlot, void> {
        yield* this.value.iterateSlots2({});
    }

    /**
     * Convert a dataset example to a program.
     *
     * This will create a program that invokes the same code as the example value,
     * and will replace all parameters with slots.
     *
     * @return {Ast.Program} the new program
     */
    toProgram() : Program {
        return declarationLikeToProgram(this);
    }
}


/**
 * An `import` statement inside a ThingTalk class.
 *
 * @alias Ast.ImportStmt
 * @extends Ast~Node
 * @abstract
 */
export abstract class ImportStmt extends Node {
    isImportStmt = true;
    static Class : any;
    isClass ! : boolean;
    static Mixin : any;
    isMixin ! : boolean;

    abstract clone() : ImportStmt;
}
ImportStmt.prototype.isClass = false;
ImportStmt.prototype.isMixin = false;

/**
 * A `import` statement that imports a whole ThingTalk class.
 *
 * @alias Ast.ImportStmt.Class
 * @extends Ast.ImportStmt
 * @deprecated Class imports were never implemented and are unlikely to be implemented soon.
 */
export class ClassImportStmt extends ImportStmt {
    kind : string;
    alias : string|null;

    /**
     * Construct a new class import statement.
     *
     * @param location - the position of this node in the source code
     * @param kind - the class identifier to import
     * @param alias - rename the imported class to the given alias
     */
    constructor(location : SourceRange|null,
                kind : string,
                alias : string|null) {
        super(location);

        assert(typeof kind === 'string');
        this.kind = kind;

        assert(alias === null || typeof alias === 'string');
        this.alias = alias;
    }

    clone() : ClassImportStmt {
        return new ClassImportStmt(this.location, this.kind, this.alias);
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        visitor.visitClassImportStmt(this);
        visitor.exit(this);
    }
}
ImportStmt.Class = ClassImportStmt;
ImportStmt.Class.prototype.isClass = true;

/**
 * A `import` statement that imports a mixin.
 *
 * Mixins add implementation functionality to ThingTalk classes, such as specifying
 * how the class is loaded (which language, which format, which version of the SDK)
 * and how devices are configured.
 *
 * @alias Ast.ImportStmt.Mixin
 * @extends Ast.ImportStmt
 */
export class MixinImportStmt extends ImportStmt {
    facets : string[];
    module : string;
    in_params : InputParam[];

    /**
     * Construct a new mixin import statement.
     *
     * @param location - the position of this node in the source code
     * @param facets - which facets to import from the mixin (`config`, `auth`, `loader`, ...)
     * @param module - the mixin identifier to import
     * @param in_params - input parameters to pass to the mixin
     */
    constructor(location : SourceRange|null,
                facets : string[],
                module : string,
                in_params : InputParam[]) {
        super(location);

        assert(Array.isArray(facets));
        this.facets = facets;

        assert(typeof module === 'string');
        this.module = module;

        assert(Array.isArray(in_params));
        this.in_params = in_params;
    }

    clone() : MixinImportStmt {
        return new MixinImportStmt(
            this.location,
            this.facets.slice(0),
            this.module,
            this.in_params.map((p) => p.clone())
        );
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        if (visitor.visitMixinImportStmt(this)) {
            for (const in_param of this.in_params)
                in_param.visit(visitor);
        }
        visitor.exit(this);
    }
}
ImportStmt.Mixin = MixinImportStmt;
ImportStmt.Mixin.prototype.isMixin = true;

/**
 * An `entity` statement inside a ThingTalk class.
 *
 * @alias Ast.EntityDef
 * @extends Ast~Node
 * @abstract
 */
export class EntityDef extends Node {
    isEntityDef = true;
    name : string;
    nl_annotations : NLAnnotationMap;
    impl_annotations : AnnotationMap;

    /**
     * Construct a new entity declaration.
     *
     * @param location - the position of this node in the source code
     * @param name - the entity name (the part after the ':')
     * @param annotations - annotations of the entity type
     * @param [annotations.nl={}] - natural-language annotations (translatable annotations)
     * @param [annotations.impl={}] - implementation annotations
     */
    constructor(location : SourceRange|null,
                name : string,
                annotations : AnnotationSpec) {
        super(location);
        /**
         * The entity name.
         */
        this.name = name;
        /**
         * The entity metadata (translatable annotations).
         */
        this.nl_annotations = annotations.nl || {};
        /**
         * The entity annotations.
         */
        this.impl_annotations = annotations.impl || {};
    }

    /**
     * Clone this entity and return a new object with the same properties.
     *
     * @return the new instance
     */
    clone() : EntityDef {
        const nl : NLAnnotationMap = {};
        Object.assign(nl, this.nl_annotations);
        const impl : AnnotationMap = {};
        Object.assign(impl, this.impl_annotations);

        return new EntityDef(this.location, this.name, { nl, impl });
    }

    /**
     * Read and normalize an implementation annotation from this entity definition.
     *
     * @param {string} name - the annotation name
     * @return {any|undefined} the annotation normalized value, or `undefined` if the
     *         annotation is not present
     */
    getImplementationAnnotation<T>(name : string) : T|undefined {
        if (Object.prototype.hasOwnProperty.call(this.impl_annotations, name))
            return this.impl_annotations[name].toJS() as T;
        else
            return undefined;
    }

    /**
     * Read a natural-language annotation from this entity definition.
     *
     * @param {string} name - the annotation name
     * @return {any|undefined} the annotation value, or `undefined` if the
     *         annotation is not present
     */
    getNaturalLanguageAnnotation(name : string) : any|undefined {
        if (Object.prototype.hasOwnProperty.call(this.nl_annotations, name))
            return this.nl_annotations[name];
        else
            return undefined;
    }

    visit(visitor : NodeVisitor) : void {
        visitor.enter(this);
        visitor.visitEntityDef(this);
        visitor.exit(this);
    }
}
