#!/usr/bin/perl
use strict;
use warnings;
use User;

sub process_user {
    my $user = User->new("John Doe", "john\@example.com");
    $user->save();
    
    my $loaded_user = User->load(123);
    $loaded_user->set_email("updated\@example.com");
    $loaded_user->save();
    
    return $user;
}

sub main {
    my $user = process_user();
    print "Processed user: " . $user->get_name() . "\n";
}

main();