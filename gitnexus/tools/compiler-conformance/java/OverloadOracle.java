import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import javax.lang.model.element.Element;
import javax.lang.model.element.NestingKind;
import javax.lang.model.element.TypeElement;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import javax.tools.*;

/** Attribute each fixture in its own javac task, all in the same JVM. */
class OverloadOracle extends TreePathScanner<Void, MethodTree> {
    private final int fixtureIndex;
    private final Path root;
    private final Set<String> families;
    private final Trees trees;
    private final Elements elements;
    private final Types types;
    private final Set<String> constructorLines = new HashSet<>();
    private final List<Diagnostic<? extends JavaFileObject>> errors;

    private OverloadOracle(int fixtureIndex, Path root, Set<String> families, Trees trees, Elements elements, Types types,
                           List<Diagnostic<? extends JavaFileObject>> errors) {
        this.fixtureIndex = fixtureIndex;
        this.root = root;
        this.families = families;
        this.trees = trees;
        this.elements = elements;
        this.types = types;
        this.errors = errors;
    }

    public static void main(String[] args) throws Exception {
        var compiler = ToolProvider.getSystemJavaCompiler();
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
                for (var error : diagnostics.getDiagnostics()) {
                    if (error.getKind() != Diagnostic.Kind.ERROR) continue;
                    if (rejection(error) == null) {
                        throw new IllegalStateException(error.toString());
                    }
                    errors.add(error);
                }
                var oracle = new OverloadOracle(i / 2, root, Set.of(args[i + 1].split(",")),
                        Trees.instance(task), task.getElements(), task.getTypes(), errors);
                for (var unit : units) oracle.scan(unit, null);
                if (!errors.isEmpty()) throw new IllegalStateException("Unmatched " + errors);
            }
        }
    }

    private static String rejection(Diagnostic<?> error) {
        return switch (error.getCode()) {
            case "compiler.err.ref.ambiguous" -> "ambiguous";
            case "compiler.err.cant.apply.symbol", "compiler.err.cant.apply.symbols",
                 "compiler.err.non-static.cant.be.ref" -> "inapplicable";
            default -> null;
        };
    }

    private void emit(String kind, String... fields) {
        var record = new StringJoiner("\0", "", "\0");
        record.add(Integer.toString(fixtureIndex)).add(kind);
        for (var field : fields) record.add(field);
        System.out.print(record);
    }

    private String file(CompilationUnitTree unit) {
        return root.relativize(Path.of(unit.getSourceFile().toUri())).toString().replace('\\', '/');
    }

    // javac's display column expands tabs. GitNexus counts UTF-16 code units.
    private String position(CompilationUnitTree unit, long offset) {
        var line = unit.getLineMap().getLineNumber(offset);
        return line + ":" + (offset - unit.getLineMap().getStartPosition(line));
    }

    private String declaration(CompilationUnitTree unit, Tree method) {
        var start = trees.getSourcePositions().getStartPosition(unit, method);
        return file(unit) + "#" + position(unit, start);
    }

    private String callerDeclaration(CompilationUnitTree unit, MethodTree caller) {
        if (caller != null) return declaration(unit, caller);
        var parent = getCurrentPath();
        while (parent != null && !(parent.getLeaf() instanceof ClassTree)) parent = parent.getParentPath();
        if (parent == null) throw new IllegalStateException("No source owner for " + getCurrentPath().getLeaf());
        return file(unit) + "#" + elements.getBinaryName((TypeElement) trees.getElement(parent));
    }

    private void emitReference(String kind, String from, String to) {
        var path = getCurrentPath();
        var unit = path.getCompilationUnit();
        var positions = trees.getSourcePositions();
        emit("reference", kind, file(unit),
                position(unit, positions.getStartPosition(unit, path.getLeaf())),
                position(unit, positions.getEndPosition(unit, path.getLeaf())), from, to);
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
        var unit = getCurrentPath().getCompilationUnit();
        var binary = elements.getBinaryName(element).toString();
        var kind = switch (type.getKind()) {
            case CLASS -> "Class";
            case ENUM -> type.getSimpleName().length() == 0 ? "Class" : "Enum";
            case RECORD -> "Record";
            case ANNOTATION_TYPE -> "Annotation";
            case INTERFACE -> "Interface";
            default -> throw new IllegalStateException("Unexpected type " + type.getKind());
        };
        emit("declaration", file(unit), kind, type.getSimpleName().toString(), binary, qualifiedTypeName(element, binary));
        for (var component : element.getRecordComponents()) {
            var accessor = trees.getPath(component.getAccessor());
            if (accessor == null || trees.getSourcePositions().getEndPosition(unit, accessor.getLeaf()) < 0) {
                emit("declaration", file(unit), "ImplicitAccessor", component.getSimpleName().toString(), "", "");
            }
        }
        var bases = new ArrayList<Tree>(type.getImplementsClause());
        if (type.getExtendsClause() != null) bases.add(type.getExtendsClause());
        for (var base : bases) {
            var mirror = trees.getTypeMirror(new TreePath(getCurrentPath(), base));
            if (!(types.asElement(mirror) instanceof TypeElement parent)) continue;
            var target = trees.getPath(parent);
            if (target == null) continue; // Platform and dependency declarations have no fixture source.
            var from = file(unit) + "#" + binary;
            var to = file(target.getCompilationUnit()) + "#" + elements.getBinaryName(parent);
            var relation = parent.getKind().isInterface() ? "IMPLEMENTS" : "EXTENDS";
            emit("heritage", relation, from, to);
        }
        return super.visitClass(type, null);
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
            emit("declaration", file(unit), "Method", method.getName().toString(), "", "");
        }
        return super.visitMethod(method, method);
    }

    // GitNexus publishes aggregate constructor edges. An explicit constructor has a
    // declaration line; an implicit default constructor is represented by its type.
    private void constructorEdge(MethodTree caller) {
        var call = getCurrentPath();
        var unit = call.getCompilationUnit();
        if (!families.contains("<init>") || trees.getSourcePositions().getEndPosition(unit, call.getLeaf()) < 0) return;
        var constructor = trees.getElement(call);
        var target = constructor == null ? null : trees.getPath(constructor);
        if (target == null) return;
        var source = target.getCompilationUnit();
        var positions = trees.getSourcePositions();
        var owner = (TypeElement) constructor.getEnclosingElement();
        var destination = positions.getEndPosition(source, target.getLeaf()) < 0
                ? file(source) + "#" + elements.getBinaryName(owner)
                : constructorLine(source, target.getLeaf());
        var from = caller != null && caller.getReturnType() == null
                ? constructorLine(unit, caller) : callerDeclaration(unit, caller);
        if (call.getLeaf() instanceof MemberReferenceTree) emitReference("Constructor", from, destination);
        else emit("constructor", from, destination);
    }

    private String constructorLine(CompilationUnitTree unit, Tree tree) {
        var line = unit.getLineMap().getLineNumber(trees.getSourcePositions().getStartPosition(unit, tree));
        return file(unit) + "#constructor:" + line;
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
                        declaration(target.getCompilationUnit(), method));
            }
        }
        return super.visitMemberReference(reference, caller);
    }

    private Optional<Diagnostic<? extends JavaFileObject>> callError(CompilationUnitTree unit, MethodInvocationTree call) {
        var positions = trees.getSourcePositions();
        var select = call.getMethodSelect();
        return errors.stream().filter(d -> d.getSource().equals(unit.getSourceFile())
                && d.getStartPosition() == positions.getStartPosition(unit, select)
                && (d.getEndPosition() == positions.getEndPosition(unit, select)
                    || d.getEndPosition() == positions.getEndPosition(unit, call))).findFirst();
    }

    // javac can assign a recovery return type after rejecting the call that
    // produces a receiver. That type cannot establish a downstream method target.
    private boolean hasRejectedReceiver(CompilationUnitTree unit, ExpressionTree select) {
        ExpressionTree receiver = select;
        while (true) {
            if (receiver instanceof MemberSelectTree member) receiver = member.getExpression();
            else if (receiver instanceof ArrayAccessTree array) receiver = array.getExpression();
            else if (receiver instanceof ParenthesizedTree parens) receiver = parens.getExpression();
            else if (receiver instanceof MethodInvocationTree producer) {
                if (callError(unit, producer).isPresent()) return true;
                receiver = producer.getMethodSelect();
            } else return false;
        }
    }

    @Override public Void visitMethodInvocation(MethodInvocationTree call, MethodTree caller) {
        var select = call.getMethodSelect();
        var name = select instanceof MemberSelectTree member
                ? member.getIdentifier().toString() : select.toString();
        if (name.equals("super") || name.equals("this")) {
            constructorEdge(caller);
            return super.visitMethodInvocation(call, caller);
        }
        boolean allSource = families.contains("*");
        if (allSource || families.contains(name)) {
            var unit = getCurrentPath().getCompilationUnit();
            var positions = trees.getSourcePositions();
            var start = positions.getStartPosition(unit, call);
            var end = positions.getEndPosition(unit, call);
            var diagnostic = callError(unit, call);
            // An invalid call can still have a recovery declaration. Classify its diagnostic first.
            var status = diagnostic.map(OverloadOracle::rejection).orElse("resolved");
            if (diagnostic.isEmpty() && !errors.isEmpty() && hasRejectedReceiver(unit, select)) {
                status = "receiver-unresolved";
            }
            diagnostic.ifPresent(errors::remove);
            var target = "";
            var signature = "";
            if (status.equals("resolved")) {
                var element = trees.getElement(getCurrentPath());
                var path = element == null ? null : trees.getPath(element);
                if (path == null || !(path.getLeaf() instanceof MethodTree method)) {
                    if (allSource) return super.visitMethodInvocation(call, caller);
                    throw new IllegalStateException("Expected source declaration for " + call);
                }
                target = declaration(path.getCompilationUnit(), method);
                signature = element.getEnclosingElement() + "." + element;
            }
            emit(status, file(unit), position(unit, start), position(unit, end),
                    callerDeclaration(unit, caller), target, signature);
        }
        return super.visitMethodInvocation(call, caller);
    }
}
