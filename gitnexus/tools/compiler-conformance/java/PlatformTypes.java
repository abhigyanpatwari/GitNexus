import com.sun.source.util.JavacTask;
import java.io.IOException;
import java.net.URI;
import java.util.List;
import java.util.TreeMap;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.NestingKind;
import javax.lang.model.element.PackageElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.util.ElementFilter;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;

/** Print the public top-level types in the unqualified exported packages of Java SE 21. */
class PlatformTypes {
    private static List<String> publicTypes(PackageElement pkg) {
        return ElementFilter.typesIn(pkg.getEnclosedElements()).stream()
                .filter(type -> type.getNestingKind() == NestingKind.TOP_LEVEL)
                .filter(type -> type.getModifiers().contains(Modifier.PUBLIC))
                .map(TypeElement::getSimpleName)
                .map(Object::toString)
                .sorted()
                .toList();
    }

    public static void main(String[] args) throws IOException {
        if (Runtime.version().feature() != 21) throw new IllegalStateException("Use JDK 21");
        var compiler = ToolProvider.getSystemJavaCompiler();
        var source = new SimpleJavaFileObject(URI.create("string:///Inventory.java"), JavaFileObject.Kind.SOURCE) {
            @Override
            public CharSequence getCharContent(boolean ignoreEncodingErrors) {
                return "class Inventory {}";
            }
        };
        try (var files = compiler.getStandardFileManager(null, null, null)) {
            var task = (JavacTask) compiler.getTask(null, files, null,
                    List.of("--add-modules", "java.se", "-proc:none"), null, List.of(source));
            task.analyze();
            var packages = new TreeMap<String, List<String>>();
            for (var module : task.getElements().getAllModuleElements()) {
                if (!module.getQualifiedName().toString().startsWith("java.")) continue;
                for (var export : ElementFilter.exportsIn(module.getDirectives())) {
                    if (export.getTargetModules() == null || export.getTargetModules().isEmpty()) {
                        var pkg = export.getPackage();
                        packages.put(pkg.getQualifiedName().toString(), publicTypes(pkg));
                    }
                }
            }
            packages.forEach((name, types) -> System.out.println(name + " " + String.join(" ", types)));
        }
    }
}
