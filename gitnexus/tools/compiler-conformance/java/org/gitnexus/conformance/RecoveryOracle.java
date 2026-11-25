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
import javax.lang.model.element.*;
import javax.lang.model.type.TypeKind;
import javax.tools.*;

/** Report the source declarations selected in programs that may have unrelated compile errors. */
class RecoveryOracle {
    public static void main(String[] roots) throws Exception {
        try (var out = new FileOutputStream(FileDescriptor.out)) {
            var compiler = ToolProvider.getSystemJavaCompiler();
            for (var rootString : roots) inspect(compiler, rootString, out);
        }
    }

    private static void inspect(JavaCompiler compiler, String rootString, FileOutputStream out) throws IOException {
        var root = Path.of(rootString).toAbsolutePath().normalize();
        try (var fm = compiler.getStandardFileManager(null, Locale.ROOT, StandardCharsets.UTF_8);
             var paths = Files.walk(root)) {
            fm.setLocationFromPaths(StandardLocation.CLASS_PATH, List.of());
            var sources = paths.filter(p -> p.toString().endsWith(".java")).sorted().toList();
            var diagnostics = new DiagnosticCollector<JavaFileObject>();
            var task = (JavacTask) compiler.getTask(null, fm, diagnostics,
                    List.of("--release", "21", "-proc:none", "-Xmaxerrs", "100000"), null,
                    fm.getJavaFileObjectsFromPaths(sources));
            var units = task.parse();
            task.analyze();
            var errors = diagnostics.getDiagnostics().stream()
                    .filter(d -> d.getKind() == Diagnostic.Kind.ERROR).toList();
            for (var error : errors) {
                emit(out, rootString, "error", error.getCode());
            }
            var trees = Trees.instance(task);
            var scanner = new RecoveryScanner(root, rootString, task, trees, errors, out);
            for (var unit : units) scanner.scan(unit, null);
            emit(out, rootString, "end");
        }
    }

    static void emit(FileOutputStream out, String... fields) {
        try {
            out.write((String.join("\0", fields) + "\0").getBytes(StandardCharsets.UTF_8));
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }
}

/** Recover source targets at valid calls even when other parts of the project have errors. */
final class RecoveryScanner extends TreePathScanner<Void, String> {
    private final Path root;
    private final String rootString;
    private final JavacTask task;
    private final Trees trees;
    private final List<Diagnostic<? extends JavaFileObject>> errors;
    private final FileOutputStream out;

    RecoveryScanner(Path root, String rootString, JavacTask task, Trees trees,
                    List<Diagnostic<? extends JavaFileObject>> errors, FileOutputStream out) {
        this.root = root;
        this.rootString = rootString;
        this.task = task;
        this.trees = trees;
        this.errors = errors;
        this.out = out;
    }

    private String location(CompilationUnitTree unit, long offset) {
        var file = root.relativize(Path.of(unit.getSourceFile().toUri()));
        var line = unit.getLineMap().getLineNumber(offset);
        var column = offset - unit.getLineMap().getStartPosition(line);
        return file.toString().replace('\\', '/') + "#" + line + ":" + column;
    }
    private String declaration(TreePath path) {
        return location(path.getCompilationUnit(),
                trees.getSourcePositions().getStartPosition(path.getCompilationUnit(), path.getLeaf()));
    }
    @Override public Void visitClass(ClassTree type, String caller) {
        return super.visitClass(type, null);
    }
    @Override public Void visitMethod(MethodTree method, String caller) {
        var unit = getCurrentPath().getCompilationUnit();
        if (trees.getSourcePositions().getEndPosition(unit, method) < 0) return null;
        var here = declaration(getCurrentPath());
        var element = trees.getElement(getCurrentPath());
        if (element != null && element.getEnclosingElement() instanceof TypeElement owner) {
            var binary = task.getElements().getBinaryName(owner).toString();
            var file = here.substring(0, here.lastIndexOf('#'));
            RecoveryOracle.emit(out, rootString, "method", here, file, binary, method.getName().toString(),
                    Integer.toString(method.getParameters().size()));
        }
        return super.visitMethod(method, here);
    }
    @Override public Void visitMethodInvocation(MethodInvocationTree call, String caller) {
        var select = call.getMethodSelect();
        var unit = getCurrentPath().getCompilationUnit();
        var start = trees.getSourcePositions().getStartPosition(unit, select);
        var end = trees.getSourcePositions().getEndPosition(unit, select);
        if (caller != null && end >= 0 && !reportedError(unit, start, end) && !hasErroneousArgument(unit, call)) {
            var element = trees.getElement(getCurrentPath());
            var target = element == null ? null : trees.getPath(element);
            if (target != null && target.getLeaf() instanceof MethodTree method && method.getReturnType() != null)
                RecoveryOracle.emit(out, rootString, "call", caller, method.getName().toString(), declaration(target));
        }
        return super.visitMethodInvocation(call, caller);
    }

    private boolean reportedError(CompilationUnitTree unit, long start, long end) {
        return errors.stream().anyMatch(d -> unit.getSourceFile().equals(d.getSource())
                && start <= d.getPosition() && d.getPosition() < end);
    }

    private boolean hasErroneousArgument(CompilationUnitTree unit, MethodInvocationTree call) {
        if (errors.isEmpty()) return false;
        var positions = trees.getSourcePositions();
        for (var argument : call.getArguments()) {
            if (reportedError(unit, positions.getStartPosition(unit, argument), positions.getEndPosition(unit, argument))
                    && new ArgumentErrors(trees).scan(argument, getCurrentPath())) return true;
        }
        return false;
    }
}

/** A recovery type on an evaluated argument cannot establish an overload target.
 * Errors in a callback or an anonymous class body can coexist with a valid outer selection. */
final class ArgumentErrors extends TreeScanner<Boolean, TreePath> {
    private final Trees trees;

    ArgumentErrors(Trees trees) { this.trees = trees; }

    @Override public Boolean scan(Tree tree, TreePath parent) {
        if (tree == null) return false;
        var path = new TreePath(parent, tree);
        if (tree instanceof ExpressionTree) {
            var type = trees.getTypeMirror(path);
            if (type != null && type.getKind() == TypeKind.ERROR) return true;
        }
        if (tree instanceof LambdaExpressionTree || tree instanceof ClassTree) return false;
        return Boolean.TRUE.equals(tree.accept(this, path));
    }

    @Override public Boolean reduce(Boolean left, Boolean right) {
        return Boolean.TRUE.equals(left) || Boolean.TRUE.equals(right);
    }
}
