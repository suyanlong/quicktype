import { setFilter, iterableFirst, mapMapEntries } from "collection-utils";

import { TypeGraph, TypeRef, typeRefIndex } from "./TypeGraph";
import { TargetLanguage } from "./TargetLanguage";
import {
    UnionType,
    TypeKind,
    EnumType,
    Type,
    ArrayType,
    PrimitiveType,
    isPrimitiveStringTypeKind,
    targetTypeKindForTransformedStringTypeKind
} from "./Type";
import { GraphRewriteBuilder } from "./GraphRewriting";
import { defined, assert, panic } from "./support/Support";
import {
    UnionInstantiationTransformer,
    DecodingChoiceTransformer,
    Transformation,
    transformationTypeAttributeKind,
    StringMatchTransformer,
    StringProducerTransformer,
    ChoiceTransformer,
    Transformer,
    DecodingTransformer,
    ParseStringTransformer,
    ArrayDecodingTransformer
} from "./Transformers";
import { TypeAttributes, emptyTypeAttributes, combineTypeAttributes } from "./TypeAttributes";
import { StringTypes } from "./StringTypes";
import { RunContext } from "./Run";

function transformationAttributes(
    graph: TypeGraph,
    reconstitutedTargetType: TypeRef,
    transformer: Transformer,
    debugPrintTransformations: boolean
): TypeAttributes {
    const transformation = new Transformation(graph, reconstitutedTargetType, transformer);
    if (debugPrintTransformations) {
        console.log(`transformation for ${typeRefIndex(reconstitutedTargetType)}:`);
        transformation.debugPrint();
        console.log(`reverse:`);
        transformation.reverse.debugPrint();
    }
    return transformationTypeAttributeKind.makeAttributes(transformation);
}

function makeEnumTransformer(
    graph: TypeGraph,
    enumType: EnumType,
    stringType: TypeRef,
    continuation?: Transformer
): Transformer {
    const sortedCases = Array.from(enumType.cases).sort();
    const caseTransformers = sortedCases.map(
        c =>
            new StringMatchTransformer(
                graph,
                stringType,
                new StringProducerTransformer(graph, stringType, continuation, c),
                c
            )
    );
    return new ChoiceTransformer(graph, stringType, caseTransformers);
}

function replaceUnion(
    union: UnionType,
    builder: GraphRewriteBuilder<Type>,
    forwardingRef: TypeRef,
    debugPrintTransformations: boolean
): TypeRef {
    const graph = builder.typeGraph;

    assert(union.members.size > 0, "We can't have empty unions");

    // Type attributes that we lost during reconstitution.
    let additionalAttributes = emptyTypeAttributes;

    function reconstituteMember(t: Type): TypeRef {
        // Special handling for some transformed string type kinds: The type in
        // the union must be the target type, so if one already exists, use that
        // one, otherwise make a new one.
        if (isPrimitiveStringTypeKind(t.kind)) {
            const targetTypeKind = targetTypeKindForTransformedStringTypeKind(t.kind);
            if (targetTypeKind !== undefined) {
                const targetTypeMember = union.findMember(targetTypeKind);
                additionalAttributes = combineTypeAttributes("union", additionalAttributes, t.getAttributes());
                if (targetTypeMember !== undefined) {
                    return builder.reconstituteType(targetTypeMember);
                }
                return builder.getPrimitiveType(targetTypeKind);
            }
        }
        return builder.reconstituteType(t);
    }

    const reconstitutedMembersByKind = mapMapEntries(union.members.entries(), m => [m.kind, reconstituteMember(m)]);
    const reconstitutedMemberSet = new Set(reconstitutedMembersByKind.values());
    const haveUnion = reconstitutedMemberSet.size > 1;

    if (!haveUnion) {
        builder.setLostTypeAttributes();
    }

    const reconstitutedTargetType = haveUnion
        ? builder.getUnionType(union.getAttributes(), reconstitutedMemberSet)
        : defined(iterableFirst(reconstitutedMemberSet));

    function memberForKind(kind: TypeKind) {
        return defined(reconstitutedMembersByKind.get(kind));
    }

    function consumer(memberTypeRef: TypeRef): Transformer | undefined {
        if (!haveUnion) return undefined;
        return new UnionInstantiationTransformer(graph, memberTypeRef);
    }

    function transformerForKind(kind: TypeKind) {
        const member = union.findMember(kind);
        if (member === undefined) return undefined;
        const memberTypeRef = memberForKind(kind);
        return new DecodingTransformer(graph, memberTypeRef, consumer(memberTypeRef));
    }

    let maybeStringType: TypeRef | undefined = undefined;
    function getStringType(): TypeRef {
        if (maybeStringType === undefined) {
            maybeStringType = builder.getStringType(emptyTypeAttributes, StringTypes.unrestricted);
        }
        return maybeStringType;
    }

    function transformerForStringType(t: Type): Transformer | undefined {
        const memberRef = memberForKind(t.kind);
        if (t.kind === "string") {
            return consumer(memberRef);
        } else if (t instanceof EnumType) {
            return makeEnumTransformer(graph, t, getStringType(), consumer(memberRef));
        } else {
            return new ParseStringTransformer(graph, getStringType(), consumer(memberRef));
        }
    }

    const stringTypes = union.stringTypeMembers;
    let transformerForString: Transformer | undefined;
    if (stringTypes.size === 0) {
        transformerForString = undefined;
    } else if (stringTypes.size === 1) {
        const t = defined(iterableFirst(stringTypes));
        transformerForString = transformerForKind(t.kind);
    } else {
        transformerForString = new DecodingTransformer(
            graph,
            getStringType(),
            new ChoiceTransformer(
                graph,
                getStringType(),
                Array.from(stringTypes).map(t => defined(transformerForStringType(t)))
            )
        );
    }

    const transformerForClass = transformerForKind("class");
    const transformerForMap = transformerForKind("map");
    assert(
        transformerForClass === undefined || transformerForMap === undefined,
        "Can't have both class and map in a transformed union"
    );
    const transformerForObject = transformerForClass !== undefined ? transformerForClass : transformerForMap;

    const transformer = new DecodingChoiceTransformer(
        graph,
        builder.getPrimitiveType("any"),
        transformerForKind("null"),
        transformerForKind("integer"),
        transformerForKind("double"),
        transformerForKind("bool"),
        transformerForString,
        transformerForKind("array"),
        transformerForObject
    );
    const attributes = transformationAttributes(graph, reconstitutedTargetType, transformer, debugPrintTransformations);
    return builder.getPrimitiveType(
        "any",
        combineTypeAttributes("union", attributes, additionalAttributes),
        forwardingRef
    );
}

function replaceArray(
    arrayType: ArrayType,
    builder: GraphRewriteBuilder<Type>,
    forwardingRef: TypeRef,
    debugPrintTransformations: boolean
): TypeRef {
    const anyType = builder.getPrimitiveType("any");
    const anyArrayType = builder.getArrayType(emptyTypeAttributes, anyType);
    const reconstitutedItems = builder.reconstituteType(arrayType.items);
    const transformer = new ArrayDecodingTransformer(
        builder.typeGraph,
        anyArrayType,
        undefined,
        reconstitutedItems,
        new DecodingTransformer(builder.typeGraph, anyType, undefined)
    );

    const reconstitutedArray = builder.getArrayType(
        builder.reconstituteTypeAttributes(arrayType.getAttributes()),
        reconstitutedItems
    );

    const attributes = transformationAttributes(
        builder.typeGraph,
        reconstitutedArray,
        transformer,
        debugPrintTransformations
    );

    return builder.getArrayType(attributes, anyType, forwardingRef);
}

function replaceEnum(
    enumType: EnumType,
    builder: GraphRewriteBuilder<Type>,
    forwardingRef: TypeRef,
    debugPrintTransformations: boolean
): TypeRef {
    const stringType = builder.getStringType(emptyTypeAttributes, StringTypes.unrestricted);
    const transformer = new DecodingTransformer(
        builder.typeGraph,
        stringType,
        makeEnumTransformer(builder.typeGraph, enumType, stringType)
    );
    const reconstitutedEnum = builder.getEnumType(enumType.getAttributes(), enumType.cases);
    const attributes = transformationAttributes(
        builder.typeGraph,
        reconstitutedEnum,
        transformer,
        debugPrintTransformations
    );
    return builder.getStringType(attributes, StringTypes.unrestricted, forwardingRef);
}

function replaceIntegerString(
    t: PrimitiveType,
    builder: GraphRewriteBuilder<Type>,
    forwardingRef: TypeRef,
    debugPrintTransformations: boolean
): TypeRef {
    const stringType = builder.getStringType(emptyTypeAttributes, StringTypes.unrestricted);
    const transformer = new DecodingTransformer(
        builder.typeGraph,
        stringType,
        new ParseStringTransformer(builder.typeGraph, stringType, undefined)
    );
    const attributes = transformationAttributes(
        builder.typeGraph,
        builder.getPrimitiveType("integer", builder.reconstituteTypeAttributes(t.getAttributes())),
        transformer,
        debugPrintTransformations
    );
    return builder.getStringType(attributes, StringTypes.unrestricted, forwardingRef);
}

export function makeTransformations(ctx: RunContext, graph: TypeGraph, targetLanguage: TargetLanguage): TypeGraph {
    function replace(
        setOfOneUnion: ReadonlySet<Type>,
        builder: GraphRewriteBuilder<Type>,
        forwardingRef: TypeRef
    ): TypeRef {
        const t = defined(iterableFirst(setOfOneUnion));
        if (t instanceof UnionType) {
            return replaceUnion(t, builder, forwardingRef, ctx.debugPrintTransformations);
        }
        if (t instanceof ArrayType) {
            return replaceArray(t, builder, forwardingRef, ctx.debugPrintReconstitution);
        }
        if (t instanceof EnumType) {
            return replaceEnum(t, builder, forwardingRef, ctx.debugPrintTransformations);
        }
        if (isPrimitiveStringTypeKind(t.kind)) {
            return replaceIntegerString(t as PrimitiveType, builder, forwardingRef, ctx.debugPrintReconstitution);
        }
        return panic(`Cannot make transformation for type ${t.kind}`);
    }

    const transformedTypes = setFilter(graph.allTypesUnordered(), t => targetLanguage.needsTransformerForType(t));
    const groups = Array.from(transformedTypes).map(t => [t]);
    return graph.rewrite(
        "make-transformations",
        ctx.stringTypeMapping,
        false,
        groups,
        ctx.debugPrintReconstitution,
        replace
    );
}
