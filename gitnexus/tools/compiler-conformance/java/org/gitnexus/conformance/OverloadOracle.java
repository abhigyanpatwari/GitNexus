package org.gitnexus.conformance;

import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import javax.lang.model.element.Element;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.Name;
import javax.lang.model.element.NestingKind;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.TypeKind;
import javax.lang.model.util.ElementFilter;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import javax.tools.*;

/** Attribute each fixture in its own javac task, all in the same JVM. */
class OverloadOracle {
    public static void main(String[] args) throws Exception {
        var compiler = ToolProvider.getSystemJavaCompiler();
        try (var out = new FileOutputStream(FileDescriptor.out)) {
            for (int i = 0; i < args.length; i += 2) {
                var root = Path.of(args[i]).toAbsolutePath().normalize();
                try (var files = compiler.getStandardFileManager(null, Locale.ROOT, StandardCharsets.UTF_8);
                     var walk = Files.walk(root)) {
                    files.setLocationFromPaths(StandardLocation.CLASS_PATH, List.of());
                    var sources = walk.filter(p -> p.toString().endsWith(".java")).sorted().toList();
                    var diagnostics = new DiagnosticCollector<JavaFileObject>();
                    var task = (JavacTask) compiler.getTask(null, files, diagnostics,
                            List.of("--release", "21", "-proc:none", "-Xdiags:verbose"), null,
                            files.getJavaFileObjectsFromPaths(sources));
                    var units = task.parse();
                    task.analyze();
                    var errors = new ArrayList<Diagnostic<? extends JavaFileObject>>();
                    var trees = Trees.instance(task);
                    var report = new SourceRecords(i / 2, root, trees, out);
                    var oracle = new InvocationScanner(report, Set.of(args[i + 1].split(",")),
                            trees, task.getElements(), task.getTypes(), new CallDiagnostics(trees, errors));
                    for (var error : diagnostics.getDiagnostics()) {
                        if (error.getKind() != Diagnostic.Kind.ERROR) continue;
                        if (CallDiagnostics.rejection(error) == null) {
                            report.reportDiagnostic(error);
                        } else {
                            errors.add(error);
                        }
                    }
                    for (var unit : units) oracle.scan(unit, null);
                    oracle.implementations.emitImplementations();
                    // javac also uses ref.ambiguous for type names outside invocation sites.
                    for (var error : errors) report.reportDiagnostic(error);
                }
            }
        }
    }
}

/** Encode javac positions and the NUL-delimited conformance protocol. */
final class SourceRecords {
    private final int fixtureIndex;
    private final Path root;
    private final Trees trees;
    private final FileOutputStream out;
    SourceRecords(int fixtureIndex, Path root, Trees trees, FileOutputStream out) {
        this.fixtureIndex = fixtureIndex;
        this.root = root;
        this.trees = trees;
        this.out = out;
    }

    void reportDiagnostic(Diagnostic<?> error) {
        if (!Boolean.getBoolean("gitnexus.conformance.reportDiagnostics")) {
            throw new IllegalStateException(error.toString());
        }
        emit("diagnostic", error.getCode());
    }

    void emit(String kind, String... fields) {
        var row = new StringJoiner("\0", "", "\0");
        row.add(Integer.toString(fixtureIndex)).add(kind);
        for (var field : fields) row.add(field);
        try {
            out.write(row.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    String file(CompilationUnitTree unit) {
        return root.relativize(Path.of(unit.getSourceFile().toUri())).toString().replace('\\', '/');
    }

    // javac's display column expands tabs. GitNexus counts UTF-16 code units.
    String position(CompilationUnitTree unit, long offset) {
        var line = unit.getLineMap().getLineNumber(offset);
        return line + ":" + (offset - unit.getLineMap().getStartPosition(line));
    }

    String declaration(CompilationUnitTree unit, Tree method) {
        var start = trees.getSourcePositions().getStartPosition(unit, method);
        return file(unit) + "#" + position(unit, start);
    }

    String declaration(ExecutableElement method) {
        var path = trees.getPath(method);
        return declaration(path.getCompilationUnit(), path.getLeaf());
    }
}

/** Match declared class methods to the interface methods they override. */
final class ImplementationTargets {
    private final Elements elements;
    private final SourceRecords report;
    final List<TypeElement> implementationOwners = new ArrayList<>();
    private final Map<ExecutableElement, String> classMethods = new HashMap<>();
    private final Map<Name, List<ExecutableElement>> interfaceMethods = new HashMap<>();
    ImplementationTargets(Elements elements, SourceRecords report) {
        this.elements = elements;
        this.report = report;
    }
    void recordMethod(ExecutableElement method) {
        if (method.getEnclosingElement().getKind().isInterface()) {
            interfaceMethods.computeIfAbsent(method.getSimpleName(), name -> new ArrayList<>()).add(method);
        } else {
            classMethods.put(method, report.declaration(method));
        }
    }

    void emitImplementations() {
        var reported = new HashSet<List<ExecutableElement>>();
        for (var owner : implementationOwners) {
            for (var method : ElementFilter.methodsIn(elements.getAllMembers(owner))) {
                var from = classMethods.get(method);
                if (from != null) emitImplementedContracts(owner, method, from, reported);
            }
        }
    }

    private void emitImplementedContracts(TypeElement owner, ExecutableElement method, String from,
                                          Set<List<ExecutableElement>> reported) {
        for (var contract : interfaceMethods.getOrDefault(method.getSimpleName(), List.of())) {
            if (elements.overrides(method, contract, owner) && reported.add(List.of(method, contract))) {
                report.emit("implementation", from, report.declaration(contract));
            }
        }
    }
}

/** Match javac diagnostics to invocation and receiver spans. */
final class CallDiagnostics {
    private final Trees trees;
    final List<Diagnostic<? extends JavaFileObject>> errors;
    CallDiagnostics(Trees trees, List<Diagnostic<? extends JavaFileObject>> errors) {
        this.trees = trees;
        this.errors = errors;
    }
    static String rejection(Diagnostic<?> error) {
        return switch (error.getCode()) {
            case "compiler.err.ref.ambiguous" -> "ambiguous";
            case "compiler.err.cant.apply.symbol", "compiler.err.cant.apply.symbols",
                 "compiler.err.non-static.cant.be.ref" -> "inapplicable";
            default -> null;
        };
    }

    Optional<Diagnostic<? extends JavaFileObject>> callError(CompilationUnitTree unit, MethodInvocationTree call) {
        return invocationError(unit, call, call.getMethodSelect());
    }

    Optional<Diagnostic<? extends JavaFileObject>> invocationError(CompilationUnitTree unit, Tree call, Tree select) {
        var positions = trees.getSourcePositions();
        return errors.stream().filter(d -> d.getSource().equals(unit.getSourceFile())
                && d.getStartPosition() == positions.getStartPosition(unit, select)
                && (d.getEndPosition() == positions.getEndPosition(unit, select)
                    || d.getEndPosition() == positions.getEndPosition(unit, call))).findFirst();
    }

    // javac can assign a recovery return type after rejecting the call that
    // produces a receiver. That type cannot establish a downstream method target.
    boolean hasRejectedReceiver(CompilationUnitTree unit, ExpressionTree select) {
        ExpressionTree receiver = select;
        while (receiver != null) {
            if (receiver instanceof MethodInvocationTree producer && callError(unit, producer).isPresent()) return true;
            receiver = switch (receiver) {
                case MemberSelectTree member -> member.getExpression();
                case ArrayAccessTree array -> array.getExpression();
                case ParenthesizedTree parens -> parens.getExpression();
                case MethodInvocationTree producer -> producer.getMethodSelect();
                default -> null;
            };
        }
        return false;
    }
}

/** Record type and method declarations as javac traverses them, carrying each enclosing caller. */
class DeclarationScanner extends TreePathScanner<Void, MethodTree> {
    private static final String DECLARATION = "declaration";
    final SourceRecords report;
    final Set<String> families;
    final Trees trees;
    final Elements elements;
    final Types types;
    private final Set<String> constructorLines = new HashSet<>();
    final ImplementationTargets implementations;

    DeclarationScanner(SourceRecords report, Set<String> families, Trees trees, Elements elements, Types types) {
        this.report = report;
        this.families = families;
        this.trees = trees;
        this.elements = elements;
        this.types = types;
        this.implementations = new ImplementationTargets(elements, report);
    }
    final String callerDeclaration(CompilationUnitTree unit, MethodTree caller) {
        if (caller != null) return report.declaration(unit, caller);
        var parent = getCurrentPath();
        while (parent != null && !(parent.getLeaf() instanceof ClassTree)) parent = parent.getParentPath();
        if (parent == null) throw new IllegalStateException("No source owner for " + getCurrentPath().getLeaf());
        return report.file(unit) + "#" + elements.getBinaryName((TypeElement) trees.getElement(parent));
    }

    // Local and anonymous types, and their members, have no canonical name (JLS 6.7).
    private String qualifiedTypeName(TypeElement type, String binaryName) {
        for (Element owner = type; owner instanceof TypeElement enclosing; owner = enclosing.getEnclosingElement()) {
            var nesting = enclosing.getNestingKind();
            if (nesting == NestingKind.LOCAL || nesting == NestingKind.ANONYMOUS) return binaryName;
        }
        return type.getQualifiedName().toString();
    }

    @Override public Void visitClass(ClassTree type, MethodTree enclosing) {
        var element = (TypeElement) trees.getElement(getCurrentPath());
        if (families.contains("<implements>") && element.getKind().isClass()) implementations.implementationOwners.add(element);
        var unit = getCurrentPath().getCompilationUnit();
        var binary = elements.getBinaryName(element).toString();
        var kind = switch (type.getKind()) {
            case CLASS -> "Class";
            case ENUM -> type.getSimpleName().isEmpty() ? "Class" : "Enum";
            case RECORD -> "Record";
            case ANNOTATION_TYPE -> "Annotation";
            case INTERFACE -> "Interface";
            default -> throw new IllegalStateException("Unexpected type " + type.getKind());
        };
        report.emit(DECLARATION, report.file(unit), kind, type.getSimpleName().toString(), binary, qualifiedTypeName(element, binary));
        for (var component : element.getRecordComponents()) {
            var accessor = trees.getPath(component.getAccessor());
            if (accessor == null || trees.getSourcePositions().getEndPosition(unit, accessor.getLeaf()) < 0) {
                report.emit(DECLARATION, report.file(unit), "ImplicitAccessor", component.getSimpleName().toString(), "", "");
            }
        }
        var bases = new ArrayList<Tree>(type.getImplementsClause());
        if (type.getExtendsClause() != null) bases.add(type.getExtendsClause());
        for (var base : bases) emitHeritage(base, element, unit, binary);
        return super.visitClass(type, null);
    }

    private void emitHeritage(Tree base, TypeElement element, CompilationUnitTree unit, String binary) {
        var mirror = trees.getTypeMirror(new TreePath(getCurrentPath(), base));
        if (!(types.asElement(mirror) instanceof TypeElement parent)) return;
        var target = trees.getPath(parent);
        if (target == null) return; // Platform and dependency declarations have no fixture source.
        var from = report.file(unit) + "#" + binary;
        var to = report.file(target.getCompilationUnit()) + "#" + elements.getBinaryName(parent);
        var relation = element.getKind().isInterface() || !parent.getKind().isInterface() ? "EXTENDS" : "IMPLEMENTS";
        report.emit("heritage", relation, from, to);
    }

    @Override public Void visitMethod(MethodTree method, MethodTree enclosing) {
        var unit = getCurrentPath().getCompilationUnit();
        if (trees.getSourcePositions().getEndPosition(unit, method) < 0) return super.visitMethod(method, method);
        if (method.getReturnType() == null && families.contains("<init>")
                && !constructorLines.add(constructorLine(unit, method))) {
            throw new IllegalStateException("Constructors share a declaration line: " + constructorLine(unit, method));
        }
        if (method.getReturnType() != null
                && getCurrentPath().getParentPath().getLeaf().getKind() != Tree.Kind.ANNOTATION_TYPE) {
            report.emit(DECLARATION, report.file(unit), "Method", method.getName().toString(), "", "");
            if (trees.getElement(getCurrentPath()) instanceof ExecutableElement member) {
                report.emit("method-access", report.declaration(unit, method), Boolean.toString(member.getModifiers().contains(Modifier.PUBLIC)));
                if (families.contains("<implements>")) implementations.recordMethod(member);
            }
        }
        return super.visitMethod(method, method);
    }

    final String constructorLine(CompilationUnitTree unit, Tree tree) {
        var line = unit.getLineMap().getLineNumber(trees.getSourcePositions().getStartPosition(unit, tree));
        return report.file(unit) + "#constructor:" + line;
    }
}

/** Record attributed calls and member references during the same traversal as their declarations. */
final class InvocationScanner extends DeclarationScanner {
    private final CallDiagnostics diagnostics;

    InvocationScanner(SourceRecords report, Set<String> families, Trees trees, Elements elements, Types types,
                      CallDiagnostics diagnostics) {
        super(report, families, trees, elements, types);
        this.diagnostics = diagnostics;
    }

    private void emitReference(String kind, String from, String to) {
        var path = getCurrentPath();
        var unit = path.getCompilationUnit();
        var positions = trees.getSourcePositions();
        report.emit("reference", kind, report.file(unit),
                report.position(unit, positions.getStartPosition(unit, path.getLeaf())),
                report.position(unit, positions.getEndPosition(unit, path.getLeaf())), from, to);
    }

    // GitNexus publishes aggregate constructor edges. An explicit constructor has a
    // declaration line; an implicit default constructor is represented by its type.
    private void constructorEdge(MethodTree caller) {
        var call = getCurrentPath();
        var unit = call.getCompilationUnit();
        if (!families.contains("<init>") || trees.getSourcePositions().getEndPosition(unit, call.getLeaf()) < 0) return;
        var tree = call.getLeaf();
        var select = tree instanceof MethodInvocationTree invocation ? invocation.getMethodSelect() : tree;
        var diagnostic = diagnostics.invocationError(unit, tree, select);
        if (diagnostic.isPresent()) {
            var error = diagnostic.get();
            diagnostics.errors.remove(error);
            report.emit("rejected-constructor", report.file(unit),
                    report.position(unit, trees.getSourcePositions().getStartPosition(unit, tree)),
                    CallDiagnostics.rejection(error));
            return;
        }
        var constructor = trees.getElement(call);
        var target = constructor == null ? null : trees.getPath(constructor);
        if (target == null) return;
        var source = target.getCompilationUnit();
        var positions = trees.getSourcePositions();
        var owner = (TypeElement) constructor.getEnclosingElement();
        var destination = positions.getEndPosition(source, target.getLeaf()) < 0
                ? report.file(source) + "#" + elements.getBinaryName(owner)
                : constructorLine(source, target.getLeaf());
        var from = caller != null && caller.getReturnType() == null
                ? constructorLine(unit, caller) : callerDeclaration(unit, caller);
        if (call.getLeaf() instanceof MemberReferenceTree) emitReference("Constructor", from, destination);
        else report.emit("constructor", from, destination);
    }

    @Override public Void visitNewClass(NewClassTree call, MethodTree caller) {
        constructorEdge(caller);
        return super.visitNewClass(call, caller);
    }

    @Override public Void visitMemberReference(MemberReferenceTree reference, MethodTree caller) {
        if (reference.getMode() == MemberReferenceTree.ReferenceMode.NEW) {
            constructorEdge(caller);
        } else if (families.contains("*") || families.contains(reference.getName().toString())) {
            var path = getCurrentPath();
            var element = trees.getElement(path);
            var target = element == null ? null : trees.getPath(element);
            if (target != null && target.getLeaf() instanceof MethodTree method) {
                emitReference("Method", callerDeclaration(path.getCompilationUnit(), caller),
                        report.declaration(target.getCompilationUnit(), method));
            }
        }
        return super.visitMemberReference(reference, caller);
    }

    private String binaryTarget(Element element) {
        if (!(element instanceof ExecutableElement method)
                || !(method.getEnclosingElement() instanceof TypeElement owner)
                || trees.getPath(owner) != null) return null;
        var parameters = new StringJoiner(",", "(", ")");
        for (var parameter : method.getParameters()) {
            parameters.add(types.erasure(parameter.asType()).toString());
        }
        return elements.getBinaryName(owner) + "#" + method.getSimpleName() + parameters;
    }

    private boolean erroneousReceiver(ExpressionTree select) {
        if (!(select instanceof MemberSelectTree member)) return false;
        var selectPath = new TreePath(getCurrentPath(), select);
        var receiver = trees.getTypeMirror(new TreePath(selectPath, member.getExpression()));
        return receiver != null && receiver.getKind() == TypeKind.ERROR;
    }

    @Override public Void visitMethodInvocation(MethodInvocationTree call, MethodTree caller) {
        var select = call.getMethodSelect();
        var name = select instanceof MemberSelectTree member
                ? member.getIdentifier().toString() : select.toString();
        if (name.equals("super") || name.equals("this")) {
            constructorEdge(caller);
            return super.visitMethodInvocation(call, caller);
        }
        if (families.contains("*") || families.contains(name)) reportCall(call, caller, select, name);
        return super.visitMethodInvocation(call, caller);
    }

    private void reportCall(MethodInvocationTree call, MethodTree caller, ExpressionTree select, String name) {
        var unit = getCurrentPath().getCompilationUnit();
        var positions = trees.getSourcePositions();
        var start = positions.getStartPosition(unit, call);
        var end = positions.getEndPosition(unit, call);
        var diagnostic = diagnostics.callError(unit, call);
        // An invalid call can still have a recovery declaration. Classify its diagnostic first.
        var status = diagnostic.map(CallDiagnostics::rejection).orElse("resolved");
        if (diagnostic.isEmpty() && !diagnostics.errors.isEmpty() && diagnostics.hasRejectedReceiver(unit, select)) {
            status = "receiver-unresolved";
        }
        diagnostic.ifPresent(diagnostics.errors::remove);
        var target = "";
        var signature = "";
        if (status.equals("resolved")) {
            var element = trees.getElement(getCurrentPath());
            var path = element == null ? null : trees.getPath(element);
            if (path == null || !(path.getLeaf() instanceof MethodTree method)) {
                reportNonSource(element, call, caller, unit, name);
                return;
            }
            target = report.declaration(path.getCompilationUnit(), method);
            signature = element.getEnclosingElement() + "." + element;
        }
        report.emit(status, report.file(unit), report.position(unit, start), report.position(unit, end),
                callerDeclaration(unit, caller), target, signature);
    }
    private void reportNonSource(Element element, MethodInvocationTree call, MethodTree caller, CompilationUnitTree unit, String name) {
        var select = call.getMethodSelect();
        var positions = trees.getSourcePositions();
        var start = positions.getStartPosition(unit, call);
        var end = positions.getEndPosition(unit, call);
        var binary = binaryTarget(element);
        if (binary != null) {
            report.emit("binary", report.file(unit), report.position(unit, start), report.position(unit, end), name, binary);
        } else if (!(element instanceof ExecutableElement) && erroneousReceiver(select)) {
            report.emit("receiver-unresolved", report.file(unit), report.position(unit, start), report.position(unit, end),
                    callerDeclaration(unit, caller), "", "");
        } else if (!families.contains("*")) {
            throw new IllegalStateException("Expected source declaration for " + call);
        }
    }
}
