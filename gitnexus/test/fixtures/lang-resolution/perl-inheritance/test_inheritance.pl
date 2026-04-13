#!/usr/bin/perl
use strict;
use warnings;
use Animal;
use Dog;

sub main {
    my $animal = Animal->new('Generic');
    my $dog = Dog->new('Buddy', 'Golden Retriever');
    
    $animal->speak();
    $dog->bark();
    
    print "Dog breed: " . $dog->get_breed() . "\n";
}

main();