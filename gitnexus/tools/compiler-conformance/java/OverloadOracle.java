import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import javax.lang.model.element.ExecutableElement;
import javax.tools.*;

/** Attribute each fixture in its own javac task, all in the same JVM. */
class OverloadOracle extends TreePathScanner<Void, MethodTree> {
    private final Path root;
    private final Set<String> families;
    private final Trees trees;
    private final List<Diagnostic<? extends JavaFileObject>> ambiguities;

    private OverloadOracle(Path root, Set<String> families, Trees trees,
                           List<Diagnostic<? extends JavaFileObject>> ambiguities) {
        this.root = root;
        this.families = families;
        this.trees = trees;
        this.ambiguities = ambiguities;
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
                        List.of("--release", "21", "-proc:none"), null,
                        files.getJavaFileObjectsFromPaths(sources));
                var units = task.parse();
                task.analyze();
                var ambiguities = new ArrayList<Diagnostic<? extends JavaFileObject>>();
                for (var error : diagnostics.getDiagnostics()) {
                    if (error.getKind() != Diagnostic.Kind.ERROR) continue;
                    if (!error.getCode().equals("compiler.err.ref.ambiguous")) {
                        throw new IllegalStateException(error.toString());
                    }
                    ambiguities.add(error);
                }
                var oracle = new OverloadOracle(root, Set.of(args[i + 1].split(",")),
                        Trees.instance(task), ambiguities);
                for (var unit : units) oracle.scan(unit, null);
                if (!ambiguities.isEmpty()) throw new IllegalStateException("Unmatched " + ambiguities);
            }
        }
    }

    private String file(CompilationUnitTree unit) {
        return root.relativize(Path.of(unit.getSourceFile().toUri())).toString().replace('\\', '/');
    }

    // javac's display column expands tabs. GitNexus counts UTF-16 code units.
    private String position(CompilationUnitTree unit, long offset) {
        var line = unit.getLineMap().getLineNumber(offset);
        return line + ":" + (offset - unit.getLineMap().getStartPosition(line));
    }

    private String declaration(CompilationUnitTree unit, MethodTree method) {
        var start = trees.getSourcePositions().getStartPosition(unit, method);
        return "def:" + file(unit) + "#" + position(unit, start) + ":Method:" + method.getName();
    }

    @Override public Void visitMethod(MethodTree method, MethodTree enclosing) {
        return super.visitMethod(method, method);
    }

    @Override public Void visitMethodInvocation(MethodInvocationTree call, MethodTree caller) {
        var select = call.getMethodSelect();
        var name = select instanceof MemberSelectTree member
                ? member.getIdentifier().toString() : select.toString();
        if (families.contains(name)) {
            var unit = getCurrentPath().getCompilationUnit();
            var positions = trees.getSourcePositions();
            var start = positions.getStartPosition(unit, call);
            var end = positions.getEndPosition(unit, call);
            // On ambiguity, getElement can still return javac's recovery choice.
            var ambiguous = ambiguities.removeIf(d -> d.getSource().equals(unit.getSourceFile())
                    && d.getStartPosition() == positions.getStartPosition(unit, select)
                    && d.getEndPosition() == positions.getEndPosition(unit, select));
            var target = "ambiguous";
            var signature = "ambiguous";
            if (!ambiguous) {
                var element = (ExecutableElement) trees.getElement(getCurrentPath());
                var path = trees.getPath(element);
                if (path == null || !(path.getLeaf() instanceof MethodTree method)) {
                    throw new IllegalStateException("Expected source declaration for " + call);
                }
                target = declaration(path.getCompilationUnit(), method);
                signature = element.getEnclosingElement() + "." + element;
            }
            System.out.println(String.join("\t", root.getFileName().toString(), file(unit),
                    position(unit, start), position(unit, end), name, declaration(unit, caller),
                    target, signature));
        }
        return super.visitMethodInvocation(call, caller);
    }
}
