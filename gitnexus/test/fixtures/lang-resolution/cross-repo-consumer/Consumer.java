package com.consumer.app;

// This import targets a class owned by an indexed DEPENDENCY repo (acme-lib).
// It resolves to no local file in this repo, so without a CrossRepoRegistry it
// creates nothing. With a registry that maps the package to the dependency repo
// (#50), ingestion creates an external File node + a CROSS_IMPORTS edge.
import com.acme.lib.Foo;

public class Consumer {
    private Foo foo;

    public Foo build() {
        return new Foo();
    }
}
